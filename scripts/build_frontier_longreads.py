#!/usr/bin/env python3
"""Merge verified bibliography snapshots. No full article text is stored or published."""
import collections,concurrent.futures as cf,datetime as dt,hashlib,html,json,math,os,re,statistics
from pathlib import Path
from urllib.parse import quote,urlsplit
import requests

ROOT=Path('data/frontier-longreads-20261002');ROOT.mkdir(parents=True,exist_ok=True)
TARGET=1000
INPUTS=[
 ('curation/frontier-1000-20261002','data/frontier-1000-20261002'),
 ('curation/frontier-1000-expand-20261002','data/frontier-1000-extra-20261002'),
 ('curation/frontier-bbc-20261002','data/frontier-1000-bbc-20261002'),
]
ALLOWED={'bbc':'bbc.com','ars':'arstechnica.com','quanta':'quantamagazine.org','ieee':'spectrum.ieee.org','row':'restofworld.org','wired':'wired.com','smithsonian':'smithsonianmag.com','techcrunch':'techcrunch.com','mit':'technologyreview.com','verge':'theverge.com'}
BAD=re.compile(r'rocket[ -]report|uncanny[ -]valley|\bpodcase\b|\b(?:weekly|daily|news|security|science) (?:roundup|round-up|round up|digest|briefing)\b|\bthis week in\b|\bweek in review\b|\b(?:best|top) (?:deals|gifts|laptops|phones|headphones)\b|\bdealmaster\b|\blink (?:roundup|round-up)\b|\b(?:sponsored|advertorial|partner content|press release)\b',re.I)
AUTH={'Accept':'application/vnd.github+json','Authorization':'Bearer '+os.environ['GH_TOKEN']} if os.environ.get('GH_TOKEN') else {'Accept':'application/vnd.github+json'}

def get_snapshot(pair):
 branch,directory=pair
 result={'branch':branch,'directory':directory,'status':'unavailable'}
 try:
  r=requests.get('https://api.github.com/repos/kdob1042/frontier/commits/'+quote(branch,safe=''),headers=AUTH,timeout=20);r.raise_for_status();sha=r.json()['sha'];result['commit']=sha
  base='https://raw.githubusercontent.com/kdob1042/frontier/'+sha+'/'+directory+'/'
  r=requests.get(base+'verified_pool.json',timeout=30);r.raise_for_status();pool=r.json()
  audit=requests.get(base+'audit.jsonl',timeout=30)
  reports=requests.get(base+'report.json',timeout=15)
  result.update(status='read',verified_pool=len(pool),report=reports.json() if reports.status_code==200 else {})
  return pool,[json.loads(line) for line in audit.text.splitlines() if line.strip()] if audit.status_code==200 else [],result
 except Exception as e:
  result['error']=str(e)[:220];return [],[],result

def title_key(s):return re.sub(r'\W+','',s.lower().replace(' | Quanta Magazine',''))

def final_gate(r):
 sid=r.get('publisher_id');url=r.get('canonical_url','')
 if sid not in ALLOWED:return 'publisher_not_allowed'
 host=urlsplit(url).netloc.lower().removeprefix('www.')
 if urlsplit(url).scheme!='https' or host!=ALLOWED[sid]:return 'non_original_url'
 if r.get('status')!='accepted':return 'not_verified'
 if r.get('word_count',0)<1500 or r.get('paragraph_count',0)<12:return 'length_or_structure'
 if not r.get('authors') or not '2015-01-01'<=r.get('published_at','')<='2026-10-02':return 'author_or_date'
 if BAD.search(' '.join([r.get('title',''),url,r.get('publisher_excerpt','')])):return 'roundup_or_excluded_format'
 return None

pools=[];all_audit=[];snapshots=[]
with cf.ThreadPoolExecutor(max_workers=3) as executor:
 for pool,audit,snapshot in executor.map(get_snapshot,INPUTS):
  pools.extend(pool);all_audit.extend(audit);snapshots.append(snapshot)
seen_u=set();seen_t=set();seen_h=set();eligible=[];rejections=[]
for r in sorted(pools,key=lambda x:(x.get('screening_score',0),x.get('published_at','')),reverse=True):
 why=final_gate(r)
 if not why:
  u=r['canonical_url'].rstrip('/');t=title_key(r['title']);h=r['body_sha256']
  if u in seen_u or t in seen_t or h in seen_h:why='cross_batch_duplicate'
  else:seen_u.add(u);seen_t.add(t);seen_h.add(h)
 if why:rejections.append({'id':r.get('id'),'url':r.get('canonical_url',r.get('url')),'reason':why});continue
 r=dict(r);r['title']=r['title'].removesuffix(' | Quanta Magazine').strip()
 r['final_review_status']='publisher_body_length_attribution_relevance_and_format_screen_pass'
 r['review_scope_ja']='本文の取得・長さ・構造・署名・日付・根拠への言及・テーマ・形式・重複を記事ごとに検査。全記事の精読や事実の独立検証を意味しません。'
 r['reading_time_basis']='English, approximately 200 words per minute; estimate'
 r['format']='long_form_article_or_single_topic_interview'
 eligible.append(r)

by=collections.defaultdict(list)
for r in eligible:by[r['publisher_id']].append(r)
# Source diversity first. No compulsory topic quotas that would dilute quality.
selected=[]
while len(selected)<TARGET:
 added=0
 for sid in sorted(by,key=lambda k:-len(by[k])):
  if by[sid]:selected.append(by[sid].pop(0));added+=1
  if len(selected)==TARGET:break
 if not added:break
selected.sort(key=lambda r:(r['published_at'],r['screening_score']),reverse=True)
for i,r in enumerate(selected,1):r['catalog_number']=i
attempts={}
for r in all_audit:
 key=(r.get('publisher_id'),r.get('url'))
 if key not in attempts or r.get('status')=='accepted':attempts[key]=r
wc=[r['word_count'] for r in selected]
report={
 'requested':TARGET,'selected':len(selected),'target_reached':len(selected)==TARGET,'eligible_unique_pool':len(eligible),
 'unique_articles_screened':len(attempts),'publisher_counts':dict(collections.Counter(r['publisher'] for r in selected)),
 'primary_topic_counts':dict(collections.Counter(r['topics'][0] for r in selected)),
 'publication_year_counts':dict(sorted(collections.Counter(r['published_at'][:4] for r in selected).items())),
 'word_count_min':min(wc,default=0),'word_count_median':statistics.median(wc) if wc else 0,'word_count_max':max(wc,default=0),'word_count_total':sum(wc),
 'estimated_reading_hours':round(sum(wc)/200/60,1),
 'retrieval_rejection_counts':dict(collections.Counter(r.get('reason','other') for r in attempts.values() if r.get('status')!='accepted')),
 'final_rejection_counts':dict(collections.Counter(r['reason'] for r in rejections)),
 'updated_at':dt.datetime.now(dt.timezone.utc).isoformat(),'snapshots':snapshots,
 'full_article_text_included':False,'full_translation_completed':False,'production_reader_imported':False,
 'verification_scope':'Individual automated full-body extraction and structural, provenance, reporting-signal and duplicate checks; metadata-based format selection. No claim of 1000 full editorial close reads or independently fact-checked articles.'
}
(ROOT/'catalog.json').write_text(json.dumps(selected,ensure_ascii=False,indent=2),encoding='utf-8')
(ROOT/'verified_eligible_pool.json').write_text(json.dumps(eligible,ensure_ascii=False,indent=2),encoding='utf-8')
(ROOT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
(ROOT/'final_rejections.json').write_text(json.dumps(rejections,ensure_ascii=False,indent=2),encoding='utf-8')
(ROOT/'retrieval_audit.jsonl').write_text('\n'.join(json.dumps(r,ensure_ascii=False) for r in attempts.values())+'\n',encoding='utf-8')

payload=json.dumps(selected,ensure_ascii=False,separators=(',',':')).replace('<','\\u003c')
page='''<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Frontier — 長文記事カタログ</title><style>
:root{color-scheme:light;--ink:#172526;--muted:#586869;--line:#dfe7e5;--accent:#166d65;--paper:#f6f8f5}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif;line-height:1.65}main{max-width:1040px;margin:auto;padding:42px 24px 70px}header{border-bottom:1px solid var(--line);padding-bottom:28px}.brand{font-size:13px;font-weight:700;letter-spacing:.18em;color:var(--accent)}h1{font-size:clamp(28px,5vw,46px);letter-spacing:-.03em;line-height:1.2;margin:18px 0}p{margin:10px 0}.lede{max-width:760px;color:var(--muted)}.stats{display:flex;flex-wrap:wrap;gap:24px;margin-top:25px}.stat strong{display:block;font-size:29px;line-height:1.25}.stat span{font-size:12px;color:var(--muted)}.controls{position:sticky;top:0;z-index:2;background:var(--paper);padding:22px 0 16px;border-bottom:1px solid var(--line)}input,select,button{font:inherit;min-height:44px;border:1px solid #bacbc7;border-radius:8px;background:#fff;color:var(--ink);padding:9px 12px}input{display:block;width:100%;margin-bottom:12px}.filters{display:flex;gap:8px;flex-wrap:wrap}select{flex:1;min-width:170px}.resultmeta{display:flex;justify-content:space-between;align-items:center;color:var(--muted);font-size:13px;margin:19px 0 4px}.card{padding:23px 0;border-bottom:1px solid var(--line)}.meta{font-size:12px;color:var(--muted);display:flex;gap:12px;flex-wrap:wrap}.publisher{font-weight:700;color:var(--accent)}h2{font-size:clamp(19px,3vw,24px);line-height:1.38;font-weight:650;margin:10px 0}a{color:inherit;text-decoration:none}a:hover{text-decoration:underline;text-underline-offset:4px}.note{font-size:14px;color:var(--muted);max-width:880px}.tags{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}.tag{font-size:11px;border:1px solid #d6e2dd;border-radius:20px;padding:3px 9px;background:#edf3ef}.source-link{font-size:13px;color:var(--accent);font-weight:600}.pages{display:flex;align-items:center;justify-content:center;gap:20px;margin:26px 0}button{cursor:pointer}button:disabled{opacity:.35;cursor:default}details{font-size:13px;color:var(--muted);border-top:1px solid var(--line);margin-top:30px;padding-top:20px}summary{cursor:pointer;font-weight:600}details p{max-width:900px}footer{font-size:12px;color:var(--muted);margin-top:26px}a:focus-visible,input:focus-visible,select:focus-visible,button:focus-visible{outline:3px solid #339f8d;outline-offset:3px}@media(max-width:600px){main{padding:26px 18px 48px}.stats{gap:18px}.stat strong{font-size:25px}.filters select{min-width:100%;font-size:14px}.controls{position:static}h1{font-size:34px}.note{font-size:13px}}</style></head><body><main><header><div class="brand">FRONTIER / LONG READS</div><h1>次の問いにつながる、長文を。</h1><p class="lede">技術・新産業・科学・社会を掘り下げる記事を、公式媒体の公開本文から選別しました。本文の転載や全文訳ではなく、原典リンクと選定台帳です。</p><div class="stats"><div class="stat"><strong>__COUNT__</strong><span>選定した記事</span></div><div class="stat"><strong>__PUBLISHERS__</strong><span>媒体</span></div><div class="stat"><strong>1,500語以上</strong><span>各記事の本文実測値</span></div><div class="stat"><strong>__MEDIAN__語</strong><span>本文量の中央値</span></div></div></header><section class="controls" aria-label="カタログの検索"><input id="q" type="search" placeholder="記事名・著者・媒体・テーマを検索" aria-label="記事を検索"><div class="filters"><select id="publisher" aria-label="媒体"><option value="">すべての媒体</option></select><select id="topic" aria-label="テーマ"><option value="">すべてのテーマ</option></select><select id="sort" aria-label="並べ替え"><option value="new">公開日の新しい順</option><option value="long">本文の長い順</option><option value="score">検査スコア順</option><option value="old">公開日の古い順</option></select></div></section><div class="resultmeta"><span id="result-count" aria-live="polite"></span><span>原文記事 / 英語</span></div><section id="items" aria-label="記事一覧"></section><nav class="pages" aria-label="ページ送り"><button id="prev">前のページ</button><span id="page"></span><button id="next">次のページ</button></nav><details><summary>選定基準と確認範囲</summary><p>各記事について、公式ページの本文取得、1,500語以上・12段落以上、著者・公開日、テーマとの関連、取材・研究・データへの言及を検査しました。正規URL・タイトル・本文ハッシュを使い、重複を除外しています。週次のニュース寄せ集め、買物ガイド、広告なども除外対象です。</p><p>これらは記事ごとの自動検査と書誌・形式の選別です。全記事を人が精読したという意味ではなく、記事内の全主張を独立に検証したという意味でもありません。読書時間は英語毎分200語の概算です。取得後の更新・削除や、地域・端末による閲覧条件の変化はあり得ます。</p><p>公開本文が取得できることと、全文保存・翻訳・転載の許諾は別です。このカタログに原文の全文や全文翻訳は含みません。知見や本人の見方を自動で採用した記録でもありません。</p></details><footer>収集基準日：2026年10月2日。各記事の公開日と本文量を保持。広告・アクセス解析・外部フォントなし。単体ファイルで検索できます。</footer></main><script id="data" type="application/json">__DATA__</script><script>
const data=JSON.parse(document.querySelector('#data').textContent);const $=x=>document.querySelector(x);let page=0;const size=40;const publishers=[...new Set(data.map(x=>x.publisher))].sort();const topics=[...new Set(data.flatMap(x=>x.topics))].sort();for(const [id,values] of [['publisher',publishers],['topic',topics]])for(const v of values){const o=document.createElement('option');o.value=v;o.textContent=v;$('#'+id).appendChild(o)}function el(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n}function render(){const q=$('#q').value.toLocaleLowerCase().trim(),p=$('#publisher').value,t=$('#topic').value;let rows=data.filter(x=>(!p||x.publisher===p)&&(!t||x.topics.includes(t))&&(!q||[x.title,x.publisher,...x.authors,...x.topics,x.reason_ja].join(' ').toLocaleLowerCase().includes(q)));const sort=$('#sort').value;rows.sort((a,b)=>sort==='long'?b.word_count-a.word_count:sort==='score'?b.screening_score-a.screening_score:sort==='old'?a.published_at.localeCompare(b.published_at):b.published_at.localeCompare(a.published_at));const pages=Math.max(1,Math.ceil(rows.length/size));page=Math.min(page,pages-1);$('#items').replaceChildren();for(const x of rows.slice(page*size,(page+1)*size)){const card=el('article',undefined,'card'),meta=el('div',undefined,'meta');meta.append(el('span',x.publisher,'publisher'),el('span',x.published_at),el('span',x.word_count.toLocaleString()+'語 / 約'+x.reading_minutes+'分'));const heading=el('h2');const link=el('a',x.title);link.href=x.canonical_url;link.target='_blank';link.rel='noopener noreferrer';heading.append(link);card.append(meta,heading,el('p',x.authors.join(' / '),'note'));const tags=el('div',undefined,'tags');for(const t of x.topics)tags.append(el('span',t,'tag'));card.append(tags,el('p',x.reason_ja,'note'));const open=el('a','原文を読む ↗','source-link');open.href=x.canonical_url;open.target='_blank';open.rel='noopener noreferrer';card.append(open);$('#items').append(card)}$('#result-count').textContent=rows.length.toLocaleString()+'件'+(rows.length?' / '+(page*size+1)+'–'+Math.min(rows.length,(page+1)*size)+'件を表示':'');$('#page').textContent=(page+1)+' / '+pages;$('#prev').disabled=page===0;$('#next').disabled=page>=pages-1}for(const id of ['q','publisher','topic','sort'])$('#'+id).addEventListener(id==='q'?'input':'change',()=>{page=0;render()});$('#prev').addEventListener('click',()=>{page--;render();$('.resultmeta').scrollIntoView()});$('#next').addEventListener('click',()=>{page++;render();$('.resultmeta').scrollIntoView()});render();
</script></body></html>'''
page=page.replace('__COUNT__',format(len(selected),',')).replace('__PUBLISHERS__',str(len(report['publisher_counts']))).replace('__MEDIAN__',format(round(report['word_count_median']),',')).replace('__DATA__',payload)
(ROOT/'index.html').write_text(page,encoding='utf-8')
readme=f'''# Frontier 長文記事カタログ\n\n選定件数: **{len(selected)} / {TARGET}**\n\n本文1,500語以上・12段落以上の公式媒体記事を、署名・公開日・根拠への言及・テーマ・形式・重複で選別した台帳です。\n\n- `index.html`: 単体で開ける検索・媒体/テーマ絞り込み付きカタログ。\n- `catalog.json`: 最終選定した記事と原典URL・実測値。\n- `report.json`: 件数、媒体、分野、公開年、除外理由、元データのコミット。\n- `retrieval_audit.jsonl`: 取得と機械的審査のログ。\n- `final_rejections.json`: 統合後の重複・形式による除外ログ。\n\n全文転載・全文翻訳・本番の日本語記事への取り込みは含みません。記事ごとの自動検査は、全記事の精読・主張の独立検証とは異なります。本人の見方やAI知見を勝手に作成・採用していません。\n\n収集基準日: 2026-10-02。記事の公開年を明記しており、古い記事を最新情報として扱いません。\n'''
(ROOT/'README.md').write_text(readme,encoding='utf-8')
print(json.dumps(report,ensure_ascii=False,indent=2))
