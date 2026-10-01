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
      await step.do('reserve bounded cost', async () => {
        const c = aiConfig(this.env);
        const capture = await loadCapture(this.env.DB, event.payload.captureId);
        const bytes = new TextEncoder().encode(
          JSON.stringify(responsePayload(capture, this.env.OPENAI_MODEL)),
        ).length;
        await reserveBudget(
          this.env,
          id,
          Math.ceil(bytes * c.inputRate + MAX_OUTPUT_TOKENS * c.outputRate),
        );
      });
      // No automatic retransmission after an ambiguous submission. Reservation remains charged conservatively.
      await step.do(
        'generate Japanese and grounded harvest',
        { retries: { limit: 0, delay: '1 second', backoff: 'constant' }, timeout: '3 minutes' },
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
            "UPDATE jobs SET status='sending',attempts=attempts+1,updated_at=? WHERE id=? AND status='reserved'",
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
            body: JSON.stringify(responsePayload(capture, this.env.OPENAI_MODEL)),
            signal: AbortSignal.timeout(120000),
          });
          if (!response.ok) {
            await response.body?.cancel();
            // A 5xx/timeout can be ambiguous. Only explicit rejected client requests release the reservation.
            const rejected =
              response.status >= 400 && response.status < 500 && response.status !== 408;
            await this.env.DB.prepare(
              'UPDATE jobs SET status=?,error_code=?,actual_micro_usd=?,updated_at=? WHERE id=?',
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
            "UPDATE jobs SET status='received',response_id=?,result_json=?,input_tokens=?,output_tokens=?,actual_micro_usd=?,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM captures WHERE id=?)",
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
        const stored = await this.env.DB.prepare('SELECT result_json FROM jobs WHERE id=?')
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
        const r = await importBundle(this.env.DB, bundle, event.payload.expectedRevision);
        await this.env.DB.prepare(
          "UPDATE jobs SET status='completed',error_code=NULL,updated_at=? WHERE id=?",
        )
          .bind(new Date().toISOString(), id)
          .run();
        return r;
      });
      return saved;
    } catch {
      await step.do('record safe failure', async () => {
        await this.env.DB.prepare(
          "UPDATE jobs SET status=CASE WHEN status='sending' THEN 'submission_unknown' WHEN status IN('budget_stopped','submission_unknown') THEN status ELSE 'failed' END,error_code=COALESCE(error_code,'processing_failed'),updated_at=? WHERE id=? AND status<>'completed'",
        )
          .bind(new Date().toISOString(), id)
          .run();
      });
      throw new Error('Harvest failed; inspect the owner job status.');
    }
  }
}
