#!/usr/bin/env python3
"""Supplemental collection with the same strict, metadata-only article checks."""
import importlib.util,json,re,time,subprocess,concurrent.futures as cf
from pathlib import Path
from urllib.parse import urljoin
from bs4 import BeautifulSoup
spec=importlib.util.spec_from_file_location('collector','scripts/collect_frontier_catalog.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
c.OUT=Path('data/frontier-1000-extra-20261002');c.OUT.mkdir(parents=True,exist_ok=True)
c.TARGET=700;c.POOL_TARGET=700
c.SOURCES=[s for s in c.SOURCES if s['id'] in ['bbc','ars','techcrunch']]
for s in c.SOURCES:s['limit']=400 if s['id']=='bbc' else 350
original_discover=c.discover

def discover(s):
 urls={};logs=[];visited=set()
 def add(u,via):
  try:u=c.canonical(urljoin(s['root'],u))
  except Exception:return
  if not c.same_host(u,s) or not re.search(s['pattern'],u):return
  yr=re.search(r'/(20\d\d)/',u)
  if yr and not 2015<=int(yr[1])<=2026:return
  if any(x in u for x in ['/audio/','/video/','/live/','/podcast/']):return
  urls.setdefault(u,via)
 try:maps=c.robots(s)
 except Exception as e:return s,[],[{'method':'robots','status':str(e)}]
 logs.append({'method':'robots_sitemaps','urls':maps})
 if s['id']=='bbc':
  selected=[u for u in maps if any(x in u.lower() for x in ['future','worklife','innovation','article','culture']) and not any(x in u.lower() for x in ['audio','video'])]
  selected += [urljoin(s['root'],p) for p in ['/future/sitemap.xml','/worklife/sitemap.xml','/innovation/sitemap.xml','/sitemaps/https-sitemap-com-future.xml','/sitemaps/https-sitemap-com-archive.xml']]
 else:selected=[urljoin(s['root'],p) for p in s['maps']]+maps
 queue=list(dict.fromkeys(selected))
 for path in s['archives']:
  u=urljoin(s['root'],path)
  try:
   text,final=c.fetch(u)
   for a in BeautifulSoup(text,'lxml').find_all('a',href=True):add(urljoin(final,a['href']),u)
  except Exception as e:logs.append({'method':'archive','url':u,'status':str(e)})
 visits=0
 while queue and visits<36 and len(urls)<9000:
  u=queue.pop(0)
  if u in visited or not c.same_host(u,s):continue
  visited.add(u);visits+=1
  try:
   text,final=c.fetch(u);xml=BeautifulSoup(text,'xml');locs=[x.get_text(strip=True) for x in xml.find_all('loc')]
   if xml.find('sitemapindex'):
    children=[x for x in locs if c.same_host(x,s) and not any(t in x.lower() for t in ['image','video','author','tag','categor','audio'])]
    def key(x):
     nums=re.findall(r'\d+',x)
     if s['id'] in ['ars','techcrunch']:return (0 if 'post' in x else 1,-int(nums[-1]) if nums else 0)
     return (0 if any(t in x.lower() for t in ['future','worklife','innovation']) else 1,-int(nums[-1]) if nums else 0)
    children.sort(key=key);queue=children[:30]+queue
   else:
    for x in locs:add(x,u)
   logs.append({'method':'sitemap','url':u,'locs':len(locs),'found':len(urls)})
  except Exception as e:logs.append({'method':'sitemap','url':u,'status':str(e)})
 # Public archive pagination adds discovery diversity when sitemaps cannot expose long reads.
 paths=['/features/page/','/science/page/','/information-technology/page/'] if s['id']=='ars' else ['/category/artificial-intelligence/page/','/category/startups/page/'] if s['id']=='techcrunch' else []
 if len(urls)<1500:
  for p in paths:
   for page in range(2,31):
    u=s['root']+p+str(page)+'/'
    try:
     text,final=c.fetch(u);before=len(urls)
     for a in BeautifulSoup(text,'lxml').find_all('a',href=True):add(urljoin(final,a['href']),u)
     if len(urls)==before and page>3:break
    except Exception as e:logs.append({'method':'pagination','url':u,'status':str(e)});break
 logs.append({'method':'final','found':len(urls)})
 arr=sorted(urls,key=c.url_priority,reverse=True)[:7000]
 print('EXPAND_DISCOVERY',s['id'],len(arr),json.dumps(logs,ensure_ascii=False),flush=True)
 return s,[(u,urls[u]) for u in arr],logs
c.discover=discover
base_write=c.write_outputs
last=0

def checkpoint(*args,**kwargs):
 global last
 base_write(*args,**kwargs)
 now=time.monotonic()
 if now-last>70 or kwargs.get('done') or (len(args)>3 and args[3]):
  subprocess.run(['git','add',str(c.OUT)],check=True)
  subprocess.run(['git','commit','-m','Checkpoint supplementary verified catalog [skip ci]'],check=False,stdout=subprocess.DEVNULL)
  subprocess.run(['git','push','origin','HEAD:curation/frontier-1000-expand-20261002'],check=True)
  last=now
c.write_outputs=checkpoint
c.main()
