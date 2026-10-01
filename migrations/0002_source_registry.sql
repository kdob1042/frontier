-- Candidate registration is not permission to fetch or translate. No unverified feed URL is guessed.
INSERT INTO source_registry(id,name,homepage,policy_json,reason) VALUES
('not-boring','Not Boring','https://www.notboring.co/','{}','取得・保存・翻訳条件の確認待ち'),
('contrary','Contrary Research','https://research.contrary.com/','{"crawl":false,"reference":"https://research.contrary.com/privacy"}','クロール・スクレイピング禁止。自動取得は無効'),
('rest-of-world','Rest of World','https://restofworld.org/','{"reference":"https://restofworld.org/about/licensing-style-guidelines/"}','再利用・翻訳条件の確認待ち'),
('techcrunch','TechCrunch','https://techcrunch.com/','{}','取得・保存・翻訳条件の確認待ち'),
('strictly-vc','StrictlyVC','https://newsletter.strictlyvc.com/','{}','公式配信と利用条件の確認待ち'),
('newcomer','Newcomer','https://www.newcomer.co/','{}','無料公開範囲と利用条件の確認待ち'),
('semianalysis','SemiAnalysis','https://semianalysis.com/','{}','無料公開範囲と利用条件の確認待ち'),
('sifted','Sifted','https://sifted.eu/','{}','無料公開範囲と利用条件の確認待ち'),
('bloomberg','Bloomberg Originals','https://www.bloomberg.com/originals/','{}','利用可能な文字資料と利用条件の確認待ち');
