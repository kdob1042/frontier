import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { aiConfig, loadCapture, processingVersion, reserveBudget, type JobParams } from './jobs';
import { importBundle } from './storage';
import {
  MAX_OUTPUT_TOKENS,
  parseResponse,
  readJsonLimited,
  responsePayload,
  verifyNumbers,
} from './openai';
import { validateBundle } from '../shared/model';
import { choosePeerRevisions, loadPeers } from './relations';
import {
  translationParts,
  reserveLongInputBytes,
  generateLong,
  settleLongFailure,
} from './long-form';
import { viewContexts, loadViewContexts } from './views';

export class HarvestWorkflow extends WorkflowEntrypoint<Env, JobParams> {
  async run(event: WorkflowEvent<JobParams>, step: WorkflowStep) {
    const id = event.instanceId;
    try {
      await step.do('check permitted capture', async () => {
        aiConfig(this.env);
        const b = await loadCapture(this.env.DB, event.payload.captureId);
        if (!b.capture.permissions.ai || !b.capture.permissions.translate)
          throw new Error('permissions_changed');
        return true;
      });
      await step.do('select bounded peer evidence', async () => {
        const capture = await loadCapture(this.env.DB, event.payload.captureId);
        const revisions = await choosePeerRevisions(this.env.DB, capture.source.url);
        const views = await viewContexts(
          this.env.DB,
          capture.source.url,
          await loadPeers(this.env.DB, revisions),
        );
        await this.env.DB.prepare(
          "UPDATE jobs SET peer_revisions_json=?,view_context_json=? WHERE id=? AND status='queued'",
        )
          .bind(JSON.stringify(revisions), JSON.stringify(views.map((v) => v.expectedRevision)), id)
          .run();
        return true;
      });
      const partCount = await step.do(
        'plan bounded translation parts',
        async () =>
          translationParts(await loadCapture(this.env.DB, event.payload.captureId)).length,
      );
      await step.do('reserve bounded cost', async () => {
        const c = aiConfig(this.env);
        const capture = await loadCapture(this.env.DB, event.payload.captureId);
        const bytes = partCount
          ? await reserveLongInputBytes(this.env, id, capture, translationParts(capture))
          : new TextEncoder().encode(
              JSON.stringify(
                responsePayload(
                  capture,
                  this.env.OPENAI_MODEL,
                  await this.peers(id),
                  await this.views(id),
                ),
              ),
            ).length;
        await reserveBudget(
          this.env,
          id,
          Math.ceil(
            bytes * c.inputRate +
              MAX_OUTPUT_TOKENS * (partCount ? partCount + 1 : 1) * c.outputRate,
          ),
        );
        if (partCount)
          await this.env.DB.batch(
            Array.from({ length: partCount + 1 }, (_, part) =>
              this.env.DB.prepare(
                "INSERT INTO job_parts(job_id,part,kind,status) VALUES(?,?,?,'queued') ON CONFLICT DO NOTHING",
              ).bind(id, part, part < partCount ? 'translation' : 'harvest_relations'),
            ),
          );
      });
      // No automatic retransmission after an ambiguous submission. Reservation remains charged conservatively.
      if (partCount) await generateLong(this.env, id, event.payload, step);
      else
        await step.do(
          'generate Japanese and grounded harvest',
          {
            retries: {
              limit: 2,
              delay: ({ error }) => Number(error.message.split(':')[1]) || 1000,
              backoff: 'constant',
            },
            timeout: '3 minutes',
          },
          async () => {
            aiConfig(this.env);
            const capture = await loadCapture(this.env.DB, event.payload.captureId);
            const existing = await this.env.DB.prepare(
              'SELECT status,result_json FROM jobs WHERE id=?',
            )
              .bind(id)
              .first<{ status: string; result_json: string | null }>();
            if (existing?.result_json) {
              parseResponse(JSON.parse(existing.result_json));
              return true;
            }
            const claimed = await this.env.DB.prepare(
              "UPDATE jobs SET status='sending',attempts=attempts+1,updated_at=? WHERE id=? AND status='reserved' AND attempts<3",
            )
              .bind(new Date().toISOString(), id)
              .run();
            if (!claimed.meta.changes) throw new Error('submission_unknown_do_not_retry');
            const response = await fetch('https://api.openai.com/v1/responses', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${this.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(
                responsePayload(
                  capture,
                  this.env.OPENAI_MODEL,
                  await this.peers(id),
                  await this.views(id),
                ),
              ),
              signal: AbortSignal.timeout(120000),
            });
            if (!response.ok) {
              const retryAfter = response.headers.get('retry-after');
              await response.body?.cancel();
              if (response.status === 429) {
                const waitSeconds = Number(retryAfter);
                const wait =
                  Number.isFinite(waitSeconds) && waitSeconds > 0
                    ? Math.min(waitSeconds * 1000, 60000)
                    : 1000;
                await this.env.DB.prepare(
                  "UPDATE jobs SET status='reserved',error_code='upstream_http_429',updated_at=? WHERE id=? AND status='sending'",
                )
                  .bind(new Date().toISOString(), id)
                  .run();
                throw new Error(`rate_limited:${wait}`);
              }
              // A 5xx/timeout can be ambiguous. Only explicit rejected client requests release the reservation.
              const rejected =
                response.status >= 400 && response.status < 500 && response.status !== 408;
              await this.env.DB.prepare(
                "UPDATE jobs SET status=?,error_code=?,actual_micro_usd=?,updated_at=? WHERE id=? AND status='sending'",
              )
                .bind(
                  rejected ? 'failed' : 'submission_unknown',
                  `upstream_http_${response.status}`,
                  rejected ? 0 : null,
                  new Date().toISOString(),
                  id,
                )
                .run();
              throw new Error('upstream_error');
            }
            const raw = await readJsonLimited(response);
            // Save response before validation so invalid outputs still count toward spending.
            const rawRecord = raw as {
              id?: unknown;
              usage?: { input_tokens?: unknown; output_tokens?: unknown };
            };
            const config = aiConfig(this.env);
            const input = rawRecord.usage?.input_tokens,
              output = rawRecord.usage?.output_tokens;
            const actual =
              typeof input === 'number' &&
              typeof output === 'number' &&
              Number.isFinite(input) &&
              Number.isFinite(output) &&
              input >= 0 &&
              output >= 0
                ? Math.ceil(input * config.inputRate + output * config.outputRate)
                : null;
            await this.env.DB.prepare(
              "UPDATE jobs SET status='received',error_code=NULL,response_id=?,result_json=?,input_tokens=?,output_tokens=?,actual_micro_usd=?,updated_at=? WHERE id=? AND status='sending' AND EXISTS(SELECT 1 FROM captures WHERE id=?)",
            )
              .bind(
                typeof rawRecord.id === 'string' ? rawRecord.id : null,
                JSON.stringify(raw),
                typeof input === 'number' ? input : null,
                typeof output === 'number' ? output : null,
                actual,
                new Date().toISOString(),
                id,
                event.payload.captureId,
              )
              .run();
            parseResponse(raw);
            // Workflows checkpoints contain IDs/flags, never source or translation text.
            return true;
          },
        );
      const saved = await step.do('validate and commit immutable rendering', async () => {
        // Re-read the source; deleted material cannot be recreated by a late workflow result.
        const current = await loadCapture(this.env.DB, event.payload.captureId);
        const stored = await this.env.DB.prepare(
          "SELECT result_json FROM jobs WHERE id=? AND status IN('received','completed')",
        )
          .bind(id)
          .first<{ result_json: string | null }>();
        if (!stored?.result_json) throw new Error('result_missing');
        const result = parseResponse(JSON.parse(stored.result_json));
        verifyNumbers(current, result.generated);
        const bundle = validateBundle({
          ...current,
          rendering: result.generated,
          processingVersion,
        });
        const r = await importBundle(this.env.DB, bundle, event.payload.expectedRevision, id);
        await this.env.DB.prepare(
          "UPDATE jobs SET status='completed',error_code=NULL,updated_at=? WHERE id=? AND status='received'",
        )
          .bind(new Date().toISOString(), id)
          .run();
        return r;
      });
      return saved;
    } catch (error) {
      const safeCodes = new Set([
        'permissions_changed',
        'ai_not_configured',
        'capture_missing',
        'source_disabled',
        'source_policy_changed',
        'number_or_paragraph_mismatch',
        'negation_review_required',
        'attribution_review_required',
        'invalid_response_json',
        'invalid_response_schema',
        'invalid_generated_schema',
        'response_refusal',
        'response_incomplete',
        'usage_missing',
        'invalid_translation_part',
        'invalid_harvest_schema',
        'missing_or_reordered_translation',
        'relation_missing_or_stale',
        'invalid_view_proposal',
        'revision_conflict',
        'result_missing',
      ]);
      const code =
        error instanceof Error &&
        (safeCodes.has(error.message) || /^upstream_http_\d{3}$/.test(error.message))
          ? error.message
          : 'processing_failed';
      await step.do('record safe failure', async () => {
        await settleLongFailure(this.env, id);
        await this.env.DB.prepare(
          "UPDATE jobs SET actual_micro_usd=CASE WHEN status='reserved' THEN 0 ELSE actual_micro_usd END,status=CASE WHEN status='sending' THEN 'submission_unknown' WHEN status IN('budget_stopped','submission_unknown','cancelled','source_deleted') THEN status ELSE 'failed' END,error_code=COALESCE(error_code,?),updated_at=? WHERE id=? AND status<>'completed'",
        )
          .bind(code, new Date().toISOString(), id)
          .run();
      });
      throw new Error('Harvest failed; inspect the owner job status.');
    }
  }
  async peers(id: string) {
    const row = await this.env.DB.prepare('SELECT peer_revisions_json FROM jobs WHERE id=?')
      .bind(id)
      .first<{ peer_revisions_json: string }>();
    return loadPeers(this.env.DB, JSON.parse(row?.peer_revisions_json || '[]'));
  }
  async views(id: string) {
    const row = await this.env.DB.prepare('SELECT view_context_json FROM jobs WHERE id=?')
      .bind(id)
      .first<{ view_context_json: string }>();
    return loadViewContexts(this.env.DB, JSON.parse(row?.view_context_json || '[]'));
  }
}
