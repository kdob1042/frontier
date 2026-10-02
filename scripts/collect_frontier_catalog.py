#!/usr/bin/env python3
"""User-directed public long-form link catalog; never exports article bodies.
No login, paywall bypass, paid AI, recurring job, or changes to app records.
"""
import concurrent.futures as cf
import collections
import csv
import datetime as dt
import hashlib
import html
import json
import math
import os
import re
import threading
import time
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit
from urllib.robotparser import RobotFileParser
import requests
from bs4 import BeautifulSoup
import trafilatura

OUT = Path('data/frontier-1000-20261002')
OUT.mkdir(parents=True, exist_ok=True)
CUTOFF = '2026-10-02'
TARGET = 1000
POOL_TARGET = 1250
UA = 'FrontierResearch/1.0 (user-directed public article link catalog; no republication)'
SOURCES = [
 dict(id='guardian', name='The Guardian', root='https://www.theguardian.com', pattern=r'/[a-z-]+/20\d\d/[a-z]{3}/\d{2}/[^/?#]+$', archives=['/news/series/the-long-read'], maps=['/sitemap.xml'], limit=400),
 dict(id='bbc', name='BBC Future / Innovation / Worklife', root='https://www.bbc.com', pattern=r'/(?:future/article/|worklife/article/|innovation/article/|article/)\d{8}-[^/?#]+', archives=['/future','/innovation','/worklife'], maps=['/sitemap.xml','/sitemaps/https-sitemap-com-archive.xml'], limit=350),
 dict(id='quanta', name='Quanta Magazine', root='https://www.quantamagazine.org', pattern=r'/[^/?#]+-20\d{6}/?$', archives=['/archive/','/tag/artificial-intelligence/','/computer-science/','/biology/','/physics/'], maps=['/sitemap_index.xml','/sitemap.xml','/post-sitemap.xml'], limit=300),
 dict(id='ars', name='Ars Technica', root='https://arstechnica.com', pattern=r'/[a-z-]+/20\d\d/\d{2}/[^/?#]+/?$', archives=['/science/','/ai/','/tech-policy/','/features/','/information-technology/'], maps=['/sitemap.xml','/sitemap_index.xml'], limit=250),
 dict(id='ieee', name='IEEE Spectrum', root='https://spectrum.ieee.org', pattern=r'^https://spectrum\.ieee\.org/[^/?#]+/?$', archives=['/artificial-intelligence/','/robotics/','/semiconductors/','/energy/','/computing/'], maps=['/sitemap.xml'], limit=250),
 dict(id='row', name='Rest of World', root='https://restofworld.org', pattern=r'/20\d\d/[^/?#]+/?$', archives=['/latest/','/series/ai/','/2026/','/2025/','/2024/'], maps=['/sitemap_index.xml','/sitemap.xml','/wp-sitemap.xml'], limit=250),
 dict(id='wired', name='WIRED', root='https://www.wired.com', pattern=r'/story/[^/?#]+/?$', archives=['/category/business/','/category/science/','/category/security/','/tag/artificial-intelligence/'], maps=['/sitemap.xml'], limit=200),
 dict(id='mit', name='MIT Technology Review', root='https://www.technologyreview.com', pattern=r'/20\d\d/\d{2}/\d{2}/\d+/[^/?#]+/?$', archives=['/topic/artificial-intelligence/','/topic/climate-change/','/topic/biotechnology/','/magazines/'], maps=['/sitemap_index.xml','/sitemap.xml','/wp-sitemap.xml'], limit=200),
 dict(id='techcrunch', name='TechCrunch', root='https://techcrunch.com', pattern=r'/20\d\d/\d{2}/\d{2}/[^/?#]+/?$', archives=['/category/artificial-intelligence/','/category/startups/','/category/climate/','/category/biotech/'], maps=['/sitemap_index.xml','/sitemap.xml','/wp-sitemap.xml'], limit=150),
 dict(id='verge', name='The Verge', root='https://www.theverge.com', pattern=r'/(?:[a-z-]+/)?(?:20\d\d/\d{1,2}/\d{1,2}/\d+|\d{5,})/[^/?#]+', archives=['/features','/ai-artificial-intelligence','/science','/policy'], maps=['/sitemap.xml'], limit=150),
 dict(id='smithsonian', name='Smithsonian Magazine', root='https://www.smithsonianmag.com', pattern=r'/(?:science-nature|innovation)/[^/?#]+-\d+/?$', archives=['/science-nature/','/innovation/'], maps=['/sitemap.xml'], limit=150),
]
TOPICS = {
 'AI・計算・半導体': ['artificial intelligence','machine learning','neural network','deep learning','language model','generative ai','chatgpt','openai','algorithm','semiconductor','chip','quantum comput','supercomput','data center','datacenter','processor','computing','silicon','transistor'],
 'ロボット・産業・宇宙': ['robot','automation','manufactur','factory','industrial','spacecraft','spacex','satellite','rocket','aviation','aerospace','drone','autonomous','self-driving','electric vehicle','supply chain','3d print'],
 '事業モデル・経済・生産性': ['startup','start-up','entrepreneur','venture capital','productivity','business model','platform','fintech','digital economy','e-commerce','ecommerce','gig economy','gig worker','tech compan','silicon valley','technology compan','innovation','blockchain','cryptocurrency','workforce','automate','automation'],
 '生命科学・医療技術・材料': ['biotech','crispr','gene edit','genetic','genome','synthetic biology','protein','neuroscience','neuron','brain','bioengineer','drug discovery','material','superconduct','fusion','medical technolog','biomedic','biology','bacteria','molecular'],
 'エネルギー・環境・インフラ': ['energy','renewable','solar','battery','batteries','decarbon','carbon capture','climate tech','clean tech','nuclear','electricity','power grid','hydrogen','heat pump','lithium','geothermal','carbon emission','climate change','electric car'],
 '技術と社会・教育・制度': ['technology','internet','social media','digital','cybersecurity','privacy','surveillance','misinformation','disinformation','online','education technology','edtech','remote work','screen time','data broker','facial recognition','tech worker','data protection']
}
BAD = re.compile(r'\b(?:best .{0,35}(?:deals|headphones|laptops|phones|gifts)|buying guide|gift guide|black friday|prime day|sponsored|advertorial|partner content|press release|daily briefing|morning briefing|live updates|liveblog|podcast|audio long read|quiz)\b', re.I)
LOCK = threading.Lock()
HOST_LOCKS = collections.defaultdict(threading.Lock)
HOST_LAST = collections.defaultdict(float)
ROBOTS = {}
AUDIT = []
DISCOVERY = []


def norm(s):
 return re.sub(r'\s+', ' ', html.unescape(str(s or ''))).strip()


def canonical(u):
 p=urlsplit(u)
 return urlunsplit(('https',p.netloc.lower(),p.path,'',''))


def hostname(u):
 return urlsplit(u).netloc.lower().removeprefix('www.')


def same_host(u, source):
 return hostname(u)==hostname(source['root'])


def fetch(url, robot=False):
 host=urlsplit(url).netloc
 if not robot:
  rp=ROBOTS.get(hostname(url))
  if rp is False: raise ValueError('robots_unavailable')
  if rp is not None and not rp.can_fetch(UA,url): raise ValueError('robots_disallowed')
 for attempt in range(3):
  try:
   with HOST_LOCKS[host]:
    gap=max(0,0.4-(time.monotonic()-HOST_LAST[host]))
    if gap: time.sleep(gap)
    HOST_LAST[host]=time.monotonic()
   r=requests.get(url,headers={'User-Agent':UA,'Accept':'text/html,application/xml,text/xml,application/rss+xml;q=0.9,*/*;q=0.5'},timeout=(8,22),allow_redirects=True)
   if r.status_code in (429,500,502,503,504):
    if attempt<2: time.sleep(2**attempt);continue
   if r.status_code!=200: raise ValueError('http_'+str(r.status_code))
   if len(r.content)>15_000_000: raise ValueError('response_too_large')
   r.encoding=r.apparent_encoding or 'utf-8'
   return r.text,r.url
  except requests.RequestException as e:
   if attempt==2: raise ValueError(type(e).__name__) from e
   time.sleep(2**attempt)
 raise ValueError('retry_exhausted')


def robots(source):
 u=source['root']+'/robots.txt'
 try:
  text,_=fetch(u,robot=True)
  rp=RobotFileParser(u);rp.parse(text.splitlines())
  ROBOTS[hostname(u)]=rp
  return rp.site_maps() or []
 except Exception as e:
  # A missing file is not a ban; an inaccessible policy is not treated as approval.
  if str(e)=='http_404':
   rp=RobotFileParser(u);rp.parse(['User-agent: *','Allow: /']);ROBOTS[hostname(u)]=rp
   return []
  ROBOTS[hostname(u)]=False
  raise


def url_priority(u):
 low=u.lower().replace('-',' ')
 score=sum(3 for words in TOPICS.values() for w in words if w in low)
 years=re.findall(r'20(?:1[5-9]|2[0-6])',u)
 score+=(int(max(years))-2014)*0.35 if years else 0
 if any(x in u for x in ['/features/','/long-read/','/science/','/innovation/']):score+=2
 return score


def discover(source):
 urls={};logs=[];visited=set()
 def add(u,via):
  try:u=canonical(urljoin(source['root'],u))
  except Exception:return
  if same_host(u,source) and re.search(source['pattern'],u) and not any(x in u for x in ['/audio/','/video/','/live/','/podcast/']):
   yr=re.search(r'/(20\d\d)/',u)
   if yr and (int(yr[1])<2015 or int(yr[1])>2026):return
   urls.setdefault(u,via)
 try: maps=robots(source)
 except Exception as e:return source,[],[{'method':'robots','status':str(e)}]
 mapqueue=list(dict.fromkeys(maps+[urljoin(source['root'],p) for p in source['maps']]))
 for path in source['archives']:
  u=urljoin(source['root'],path)
  try:
   text,final=fetch(u);soup=BeautifulSoup(text,'lxml')
   for a in soup.find_all('a',href=True):add(urljoin(final,a['href']),u)
   logs.append({'method':'archive','url':u,'found':len(urls)})
  except Exception as e:logs.append({'method':'archive','url':u,'status':str(e)})
 # Long Read archives are intentionally preferred to the newspaper's general news sitemap.
 if source['id']=='guardian':
  for page in range(2,91):
   u=source['root']+'/news/series/the-long-read?page='+str(page)
   try:
    text,final=fetch(u);before=len(urls)
    for a in BeautifulSoup(text,'lxml').find_all('a',href=True):add(urljoin(final,a['href']),u)
    if page%10==0: print('DISCOVERY',source['id'],'page',page,'candidates',len(urls),flush=True)
    if len(urls)==before and page>5:break
   except Exception as e:
    logs.append({'method':'archive_page','url':u,'status':str(e)})
    break
  mapqueue=[]
 # Breadth-bounded, publisher-only sitemap discovery; never crawl arbitrary link targets.
 visits=0
 while mapqueue and visits<22 and len(urls)<2600:
  u=mapqueue.pop(0)
  if u in visited or not same_host(u,source):continue
  visited.add(u);visits+=1
  try:
   text,final=fetch(u);soup=BeautifulSoup(text,'xml')
   locs=[x.get_text(strip=True) for x in soup.find_all('loc')]
   if soup.find('sitemapindex') is not None:
    children=[x for x in locs if same_host(x,source) and not any(t in x.lower() for t in ['image','video','author','tag','categor'])]
    children.sort(key=lambda x:(not any(t in x.lower() for t in ['post','article','content']), -int(max(re.findall(r'20[12]\d',x),default='2026'))))
    mapqueue=children[:18]+mapqueue
   else:
    for x in locs:add(x,u)
   logs.append({'method':'sitemap','url':u,'locs':len(locs),'found':len(urls)})
  except Exception as e:logs.append({'method':'sitemap','url':u,'status':str(e)})
 # Public feed discovery is a distinct fallback, not a means of bypassing restrictions.
 if len(urls)<150:
  for suffix in ['/feed/','/rss','/rss.xml','/feed.xml']:
   u=source['root']+suffix
   try:
    text,_=fetch(u);soup=BeautifulSoup(text,'xml')
    for entry in soup.find_all(['item','entry']):
     for x in entry.find_all('link'):
      add(x.get('href') or x.get_text(strip=True),u)
    logs.append({'method':'feed','url':u,'found':len(urls)})
   except Exception as e:logs.append({'method':'feed','url':u,'status':str(e)})
 arr=sorted(urls,key=url_priority,reverse=True)[:2200]
 print('DISCOVERY_DONE',source['id'],len(arr),flush=True)
 return source,[(u,urls[u]) for u in arr],logs


def ld_articles(soup):
 result=[]
 def walk(x):
  if isinstance(x,list):
   for y in x:walk(y)
  elif isinstance(x,dict):
   types=x.get('@type',[]);types=[types] if isinstance(types,str) else types
   if any(t in ['Article','NewsArticle','ReportageNewsArticle','AnalysisNewsArticle','TechArticle','BlogPosting'] for t in types):result.append(x)
   if '@graph' in x:walk(x['@graph'])
 for tag in soup.find_all('script',type='application/ld+json'):
  try:walk(json.loads(tag.string or tag.get_text()))
  except (ValueError,TypeError):pass
 return result


def author_names(x):
 if isinstance(x,str):return [norm(x)]
 if isinstance(x,list):return [n for y in x for n in author_names(y)]
 if isinstance(x,dict):return author_names(x.get('name',''))
 return []


def classify(title,text):
 sample=(title+' '+title+' '+text[:14000]).lower()
 counts={k:sum(min(8,sample.count(w)) for w in words) for k,words in TOPICS.items()}
 ordered=sorted(counts,key=counts.get,reverse=True)
 return [k for k in ordered if counts[k]>=3][:3],max(counts.values())


def assess(source,url,via):
 result={'url':url,'publisher':source['name'],'publisher_id':source['id'],'discovery_url':via,'checked_at':dt.datetime.now(dt.timezone.utc).isoformat()}
 try:
  raw,final=fetch(url)
  if not same_host(final,source):raise ValueError('cross_publisher_redirect')
  soup=BeautifulSoup(raw,'lxml')
  meta={}
  for m in soup.find_all('meta'):
   key=m.get('property') or m.get('name')
   if key:meta[key.lower()]=m.get('content','')
  lds=ld_articles(soup)
  ld=next((x for x in lds if x.get('headline')),lds[0] if lds else {})
  if str(ld.get('isAccessibleForFree','')).lower()=='false':raise ValueError('publisher_marks_paywalled')
  title=norm(ld.get('headline') or meta.get('og:title') or (soup.h1.get_text() if soup.h1 else ''))
  if not title:raise ValueError('missing_title')
  if BAD.search(title+' '+url):raise ValueError('excluded_format')
  extracted=trafilatura.extract(raw,url=final,output_format='json',with_metadata=True,include_comments=False,include_tables=False,favor_precision=True)
  obj=json.loads(extracted) if extracted else {}
  body=obj.get('text','');method='trafilatura_precision'
  if len(body.split())<1500:
   # Independent semantic-body extraction, still on the same publicly accessible page.
   main=soup.find('article') or soup.find('main')
   if main:
    for x in main.select('nav,aside,footer,script,style,form,[class*=comment],[class*=newsletter],[class*=related]'):x.decompose()
    alternative='\n'.join(norm(p.get_text(' ',strip=True)) for p in main.find_all('p') if len(p.get_text(' ',strip=True).split())>=6)
    if len(alternative.split())>len(body.split()):body=alternative;method='semantic_article_paragraphs'
  paragraphs=list(dict.fromkeys(norm(p) for p in body.splitlines() if len(p.split())>=6))
  body='\n'.join(paragraphs)
  words=len(re.findall(r"\b[\w]+(?:['’\-][\w]+)*\b",body))
  result.update(title=title,word_count=words,paragraph_count=len(paragraphs),extraction_method=method)
  if words<1500:raise ValueError('below_1500_words')
  if len(paragraphs)<12:raise ValueError('below_12_paragraphs')
  if re.search(r'(?:subscribe to (?:continue|keep) reading|unlock (?:this article|the full article)|this (?:article|content) is (?:for|exclusive to) subscribers)',body,re.I):raise ValueError('subscription_gate')
  authors=author_names(ld.get('author')) or author_names(meta.get('author')) or author_names(obj.get('author'))
  authors=list(dict.fromkeys(a for a in authors if a and len(a)<220))
  if not authors:raise ValueError('missing_author')
  published=norm(ld.get('datePublished') or meta.get('article:published_time') or meta.get('date') or obj.get('date'))
  match=re.search(r'20\d\d-\d\d-\d\d',published)
  if not match:raise ValueError('missing_publication_date')
  date=match[0]
  dt.date.fromisoformat(date)
  if date>CUTOFF:raise ValueError('future_publication')
  if date<'2015-01-01':raise ValueError('before_2015')
  topics,relevance=classify(title,body)
  if not topics or relevance<7:raise ValueError('insufficient_frontier_relevance')
  attribution=len(re.findall(r'\b(?:said|says|told|according to|researchers|scientists|study|studies|research|data|report|published|interview)\b',body,re.I))
  quotes=body.count('“')+body.count('"')//2
  numbers=len(re.findall(r'\b\d+(?:[.,]\d+)*(?:%|\b)',body))
  if attribution<5 or (quotes<2 and numbers<5):raise ValueError('insufficient_reporting_signals')
  canonical_tag=soup.find('link',rel='canonical')
  cu=canonical(urljoin(final,canonical_tag.get('href'))) if canonical_tag and canonical_tag.get('href') else canonical(final)
  if not same_host(cu,source):raise ValueError('non_original_canonical')
  score=round(min(30,words/110)+min(20,attribution)+min(15,relevance)+min(10,quotes)+min(10,numbers)+10+5,1)
  # At most 25 source words including original title; never export complete paragraphs.
  title_words=title.split()
  short_description=norm(meta.get('description') or meta.get('og:description') or ld.get('description') or '')
  remaining=max(0,25-len(title_words))
  excerpt=' '.join(short_description.split()[:remaining])
  result.update(id='frontier-'+hashlib.sha256(cu.encode()).hexdigest()[:20],canonical_url=cu,authors=authors,published_at=date,topics=topics,reading_minutes=math.ceil(words/200),screening_score=score,attribution_signals=attribution,quote_signals=quotes,numeric_signals=numbers,body_sha256=hashlib.sha256(body.lower().encode()).hexdigest(),title_key=re.sub(r'\W+','',title.lower()),publisher_excerpt=excerpt,access='public_body_verified_at_collection',review_status='per_article_automated_screen_pass',translation_status='not_translated',copyright_status='metadata_and_link_only_no_republication_permission_asserted',reason_ja=f'{source["name"]}の署名記事。本文{words:,}語・{len(paragraphs)}段落を実測。{topics[0]}を中心に、取材・研究・データへの言及{attribution}箇所を確認。',status='accepted')
  return result
 except Exception as e:
  result.update(status='rejected',reason=str(e)[:200])
  return result


def write_outputs(accepted,attempts,discovery,done=False):
 # Balance publishers without degrading the mandatory content checks.
 bysource=collections.defaultdict(list)
 for item in accepted:bysource[item['publisher_id']].append(item)
 for arr in bysource.values():arr.sort(key=lambda x:(x['screening_score'],x['published_at']),reverse=True)
 chosen=[]
 while len(chosen)<TARGET:
  added=0
  for key in sorted(bysource,key=lambda k:-len(bysource[k])):
   if bysource[key]:chosen.append(bysource[key].pop(0));added+=1
   if len(chosen)>=TARGET:break
  if not added:break
 chosen.sort(key=lambda x:(x['published_at'],x['screening_score']),reverse=True)
 for i,item in enumerate(chosen,1):item['catalog_number']=i
 (OUT/'selected.json').write_text(json.dumps(chosen,ensure_ascii=False,indent=2),encoding='utf-8')
 (OUT/'verified_pool.json').write_text(json.dumps(accepted,ensure_ascii=False,indent=2),encoding='utf-8')
 (OUT/'audit.jsonl').write_text('\n'.join(json.dumps(x,ensure_ascii=False) for x in attempts)+'\n',encoding='utf-8')
 (OUT/'discovery.json').write_text(json.dumps(discovery,ensure_ascii=False,indent=2),encoding='utf-8')
 counts=collections.Counter(x['publisher'] for x in chosen)
 topics=collections.Counter(x['topics'][0] for x in chosen)
 rejected=collections.Counter(x.get('reason','unknown') for x in attempts if x['status']!='accepted')
 wc=sorted(x['word_count'] for x in chosen)
 report=dict(requested=TARGET,selected=len(chosen),target_reached=len(chosen)==TARGET,verified_pool=len(accepted),article_attempts=len(attempts),publishers=dict(counts),primary_topics=dict(topics),rejection_reasons=dict(rejected),word_count_min=min(wc,default=0),word_count_median=wc[len(wc)//2] if wc else 0,total_words=sum(wc),updated_at=dt.datetime.now(dt.timezone.utc).isoformat(),finished=done,full_text_exported=False,full_translation_completed=False,frontier_production_imported=False,review_scope='Body extraction and individual automated metadata, length, attribution, relevance and duplicate checks. Not a claim that an editor closely read every full article.')
 (OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
 print('PROGRESS',json.dumps(report,ensure_ascii=False),flush=True)


def main():
 print('START cutoff',CUTOFF,'target',TARGET,flush=True)
 discoveries=[];queues={};source_by_id={s['id']:s for s in SOURCES}
 with cf.ThreadPoolExecutor(max_workers=8) as pool:
  futures=[pool.submit(discover,s) for s in SOURCES]
  for fut in cf.as_completed(futures):
   try:
    source,items,logs=fut.result();queues[source['id']]=collections.deque(items);discoveries.append({'publisher':source['name'],'candidate_count':len(items),'log':logs})
   except Exception as e:print('DISCOVERY_ERROR',str(e),flush=True)
 (OUT/'discovery.json').write_text(json.dumps(discoveries,ensure_ascii=False,indent=2),encoding='utf-8')
 accepted=[];attempts=[];counts=collections.Counter();seen_urls=set();seen_titles=set();seen_hashes=set()
 # Reuse verified records after a refinement run; never count a URL twice.
 old=OUT/'verified_pool.json'
 if old.exists():
  for item in json.loads(old.read_text()):
   if item.get('word_count',0)>=1500 and item.get('status')=='accepted':
    accepted.append(item);counts[item['publisher_id']]+=1;seen_urls.add(item['canonical_url']);seen_titles.add(item['title_key']);seen_hashes.add(item['body_sha256'])
 tried=set()
 previous=OUT/'audit.jsonl'
 if previous.exists():
  for line in previous.read_text().splitlines():
   if line:
    row=json.loads(line);attempts.append(row);tried.add(row['url'])
 while len(accepted)<POOL_TARGET:
  batch=[]
  for sid,queue in queues.items():
   if counts[sid]>=source_by_id[sid]['limit']:continue
   for _ in range(8):
    while queue:
     url,via=queue.popleft()
     if url not in tried and url not in seen_urls:
      tried.add(url);batch.append((source_by_id[sid],url,via));break
  if not batch:break
  with cf.ThreadPoolExecutor(max_workers=10) as pool:
   futures=[pool.submit(assess,*args) for args in batch]
   for fut in cf.as_completed(futures):
    row=fut.result()
    if row['status']=='accepted':
     if row['canonical_url'] in seen_urls or row['title_key'] in seen_titles or row['body_sha256'] in seen_hashes:
      row['status']='rejected';row['reason']='duplicate'
     else:
      accepted.append(row);counts[row['publisher_id']]+=1
      seen_urls.add(row['canonical_url']);seen_titles.add(row['title_key']);seen_hashes.add(row['body_sha256'])
    attempts.append({k:v for k,v in row.items() if k not in ['publisher_excerpt','reason_ja']})
  write_outputs(accepted,attempts,discoveries)
 write_outputs(accepted,attempts,discoveries,True)
 print('FINAL selected',min(TARGET,len(accepted)),'verified pool',len(accepted),'attempts',len(attempts),flush=True)

if __name__=='__main__':main()
