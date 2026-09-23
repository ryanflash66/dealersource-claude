-- Saved-search alert emails as a source kind (docs/decisions.md 28): LoopNet and Crexi
-- alerts read from the owner's mailbox. Widens the allowed kinds; existing rows are unaffected.
alter table sources drop constraint if exists sources_kind_check;
alter table sources add constraint sources_kind_check check (kind in ('crawl', 'reddit', 'rss', 'manual', 'email_alert'));
