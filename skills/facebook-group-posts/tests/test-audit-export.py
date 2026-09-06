"""Synthetic-only offline tests. No browser, login, real posts, or external service."""
import copy
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/audit_export.py'
spec = importlib.util.spec_from_file_location('audit_export', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def stamp(value):
    return value.isoformat().replace('+00:00', 'Z')


class Fixture:
    """Artificial group/IDs/text and literal synthetic pagination markers only."""
    def __init__(self, root, old_pages=5, version=3):
        self.root = root
        self.source = root / 'run'
        self.source.mkdir()
        self.output = root / 'delivery'
        self.start = datetime(2025, 6, 1, tzinfo=timezone.utc)
        self.scope = {'group_id':'123450000000000', 'group_url':'https://www.facebook.com/groups/synthetic-group/',
                      'start':stamp(self.start), 'end':'2025-06-10T23:59:59Z',
                      'operation':'GroupsCometFeedRegularStoriesPaginationQuery','sorting_setting':'CHRONOLOGICAL','page_size':3}
        self.records = [{'schema_version':version, **self.scope, 'page':0,'request_cursor':None,
                         'next_cursor':'synthetic-cursor-1','has_next':True,'stream_final':True,'status':'ok','posts':[]}]
        target, outside = [], []
        for page in range(1, old_pages + 2):
            day = datetime(2025,6,9,tzinfo=timezone.utc) if page==1 else self.start-timedelta(days=page-1)
            posts = [self.post(page*10+i, day+timedelta(seconds=i)) for i in range(3)]
            (target if page==1 else outside).extend(posts)
            self.records.append({'schema_version':version,**self.scope,'page':page,'request_cursor':f'synthetic-cursor-{page}',
                                 'next_cursor':f'synthetic-cursor-{page+1}','has_next':True,'stream_final':True,'status':'ok',
                                 'old_pages_before':max(0,page-2),'old_pages_after':max(0,page-1),'posts':posts})
        self.audit=[]
        self.data={'metadata':{**self.scope,'feed_pages':old_pages+1,'required_boundary_pages':5,'boundary_pages':old_pages,
                               'coverage_status':'date_boundary_reached','finished':True,'coverage_complete':True,
                               'in_range_count':len(target),'outside_range_count':len(outside),'unknown_date_count':0,
                               'cookie':'SYNTHETIC_AUTH_MARKER','raw_request':'SYNTHETIC_AUTH_MARKER'},
                   'posts':target,'outside_range_posts':outside,'undated_posts':[]}
        self.version=version
        for record in self.records:
            self.sync_record_audit(record)

    @staticmethod
    def sync_record_audit(record):
        record['audit']={'kind':'page','page':record['page'],'status':record['status'],
                         'http_status':200,'frame_count':2,'malformed_frames':0,'rejected_stories':0,'errors':[],
                         'ids':[p['post_id'] for p in record['posts']],
                         'dates':[p.get('published_at') for p in record['posts']], 'count':len(record['posts']),
                         'has_next':record['has_next'],'stream_final':record['stream_final']}
        return record

    def incomplete_before(self, index=3):
        partial=copy.deepcopy(self.records[index])
        partial.update(status='pagination_incomplete',stream_final=False,has_next=None,next_cursor=None)
        partial['posts']=partial['posts'][:1]
        self.sync_record_audit(partial)
        self.records.insert(index,partial)
        return partial

    def post(self, suffix, date=None, body='Synthetic text, never a real group post.'):
        pid=str(9007199254740993000+suffix)
        return {'post_id':pid,'url':f'{self.scope["group_url"]}posts/{pid}/?tracking=removed',
                'published_at':stamp(date) if date else None,'published_at_raw':date.timestamp() if date else None,
                'body':body,'shared_body':None,'is_shared':False,'attachment_count':0,'media_types':[],
                'shares':0,'reactions':0,'comments':0,'shares_raw':None,'reactions_raw':None,'comments_raw':None,
                'collected_at':'2025-06-11T00:00:00Z','body_truncated':False,
                'count_observed_at':{'shares':'2025-06-11T00:00:00Z','reactions':'2025-06-11T00:00:00Z','comments':'2025-06-11T00:00:00Z'},
                'source_fields':{'secret':'SYNTHETIC_AUTH_MARKER'},'authorization':'SYNTHETIC_AUTH_MARKER'}

    def write(self, rebuild_audit=True):
        if rebuild_audit:
            by_page={r['page']:r for r in self.records if r['page']>0}
            self.audit=[{'kind':'page','page':p,'ids':[v['post_id'] for v in r['posts']],
                         'dates':[v['published_at'] for v in r['posts']],'count':len(r['posts']),
                         'has_next':r['has_next'],'stream_final':r['stream_final'],'errors':[]}
                        for p,r in sorted(by_page.items())]
        histories=[]
        for number, rows in enumerate([self.records[:3],self.records[3:]],1):
            directory=self.root/f'batch-{number}'
            directory.mkdir(exist_ok=True)
            file=directory/'pagination-history-synthetic.jsonl'
            file.write_text(''.join(json.dumps(row)+'\n' for row in rows),encoding='utf-8')
            histories.append(str(file))
        usable=[r for r in self.records if r['status']=='ok' and r['has_next'] and r['stream_final']][-1]
        checkpoint={'schema_version':self.version,**self.scope,'pages':usable['page'],'next_page':usable['page']+1,
                    'cursor':usable['next_cursor'],'history_files':histories,'source_file':str(self.source/'posts.json'),
                    'audit_file':str(self.source/'crawl-audit.json')}
        for name,value in [('posts.json',self.data),('crawl-audit.json',self.audit),('pagination-checkpoint.json',checkpoint)]:
            (self.source/name).write_text(json.dumps(value),encoding='utf-8')
        return self


class AuditExportTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def fixture(self, **kwargs):
        return Fixture(self.root,**kwargs)

    def audit(self, fixture, **kwargs):
        fixture.write()
        return module.export(fixture.source,fixture.output,**kwargs)

    def codes(self, report):
        return {issue['code'] for issue in report['issues']}

    def test_valid_v3_cross_batch_boundary_and_private_fields_removed(self):
        f=self.fixture();report=self.audit(f)
        self.assertEqual(report['validity']['status'],'valid')
        self.assertTrue(report['coverage']['time_boundary_verified'])
        self.assertTrue(report['coverage']['page_chain_verified'])
        self.assertEqual(report['coverage']['cross_batch_connections_checked'],1)
        self.assertEqual(report['coverage']['consecutive_complete_old_pages'],5)
        self.assertEqual(report['coverage']['unique_old_posts_in_boundary_run'],15)
        self.assertFalse(report['review']['human_review_completed'])
        for path in f.output.iterdir():
            value=path.read_text(encoding='utf-8-sig')
            self.assertNotIn('SYNTHETIC_AUTH_MARKER',value)
            self.assertNotIn('synthetic-cursor-',value)
            self.assertNotIn(str(f.source),value)
        data=json.loads((f.output/'posts.json').read_text(encoding='utf-8'))
        self.assertEqual(len(data['posts']),3)
        self.assertEqual(len(data['outside_range_posts']),15)
        self.assertTrue(all(isinstance(row['post_id'],str) for row in data['posts']))
        self.assertTrue(all('?' not in row['url'] for row in data['posts']))

    def test_legacy_v2_accepted(self):
        f=self.fixture(version=2)
        for row in f.records:
            row.pop('operation');row.pop('group_url')
        report=self.audit(f)
        self.assertTrue(report['coverage']['time_boundary_verified'])

    def test_duplicate_records_retained_and_flagged(self):
        f=self.fixture();f.data['posts'].append(copy.deepcopy(f.data['posts'][0]));f.data['metadata']['in_range_count']=4
        report=self.audit(f)
        self.assertEqual(report['validity']['status'],'invalid')
        self.assertIn('DUPLICATE_POST_ID',self.codes(report))
        data=json.loads((f.output/'posts.json').read_text(encoding='utf-8'))
        self.assertEqual(len(data['posts']),4)

    def test_missing_journal_id_with_recomputed_counts_is_invalid(self):
        f=self.fixture();f.data=copy.deepcopy(f.data)
        removed=f.data['posts'].pop();f.data['metadata']['in_range_count']-=1
        report=self.audit(f)
        self.assertEqual(report['validity']['status'],'invalid')
        self.assertIn('JOURNAL_POST_MISSING_FROM_SNAPSHOT',self.codes(report))
        self.assertEqual(report['summary']['journal_reconciliation']['missing_journal_ids'],1)
        self.assertTrue(any(i.get('post_id')==removed['post_id'] for i in report['issues']))

    def test_changed_snapshot_body_is_invalid(self):
        f=self.fixture();f.data=copy.deepcopy(f.data)
        f.data['posts'][0]['body']='Never observed synthetic replacement'
        report=self.audit(f)
        self.assertEqual(report['validity']['status'],'invalid')
        self.assertTrue(any(i['code']=='SNAPSHOT_JOURNAL_FIELD_MISMATCH' and i.get('field')=='body' for i in report['issues']))

    def test_changed_snapshot_metric_is_invalid(self):
        f=self.fixture();f.data=copy.deepcopy(f.data);f.data['posts'][0]['shares']=999
        report=self.audit(f)
        self.assertEqual(report['validity']['status'],'invalid')
        self.assertTrue(any(i['code']=='SNAPSHOT_JOURNAL_FIELD_MISMATCH' and i.get('field')=='shares' for i in report['issues']))

    def test_changed_snapshot_shared_body_and_date_bucket_are_invalid(self):
        f=self.fixture();f.data=copy.deepcopy(f.data);row=f.data['posts'].pop()
        row.update(shared_body='Not in journal',published_at=stamp(f.start-timedelta(days=1)),published_at_raw=(f.start-timedelta(days=1)).timestamp())
        f.data['outside_range_posts'].append(row)
        f.data['metadata'].update(in_range_count=2,outside_range_count=16)
        report=self.audit(f)
        self.assertEqual(report['validity']['status'],'invalid')
        fields={i.get('field') for i in report['issues'] if i['code']=='SNAPSHOT_JOURNAL_FIELD_MISMATCH'}
        self.assertTrue({'shared_body','published_at','record_bucket'}<=fields)

    def test_unknown_journal_date_cannot_be_reclassified_as_known(self):
        f=self.fixture();row=f.post(999,None)
        f.records[0]['posts'].append(row);f.data['metadata']['in_range_count']+=1
        invented=copy.deepcopy(row);invented.update(published_at=stamp(f.start),published_at_raw=f.start.timestamp())
        f.data['posts'].append(invented)
        report=self.audit(f)
        self.assertEqual(report['validity']['status'],'invalid')
        self.assertIn('SNAPSHOT_JOURNAL_FIELD_MISMATCH',self.codes(report))

    def test_legacy_difference_is_review_and_unjournaled_seed_preserved(self):
        f=self.fixture(version=2);f.data=copy.deepcopy(f.data)
        f.data['posts'][0]['body']='Legacy source merged without reconstructible field lineage'
        f.data['posts'].append(f.post(999,f.start));f.data['metadata']['in_range_count']+=1
        report=self.audit(f)
        self.assertEqual(report['validity']['status'],'valid')
        self.assertEqual(report['summary']['journal_reconciliation']['status'],'not_fully_verified')
        self.assertIn('LEGACY_SNAPSHOT_JOURNAL_MISMATCH',self.codes(report))
        self.assertIn('SNAPSHOT_ID_NOT_JOURNAL_VERIFIED',self.codes(report))
        data=json.loads((f.output/'posts.json').read_text(encoding='utf-8'))
        self.assertEqual(len(data['posts']),4)
        self.assertEqual(sum(p['journal_status']=='not_journal_verified' for p in data['posts']),1)

    def test_valid_null_fallback_and_field_observation_times_replayed(self):
        f=self.fixture();old=f.data['posts'][0];old['shares']=7;old['body_known']=True
        old['field_observed_at']={key:old['collected_at'] for key in ('body','url','publication_time')}
        fresh=copy.deepcopy(old);later='2025-06-12T00:00:00Z'
        fresh.update(url=None,published_at=None,published_at_raw=None,body='',body_known=False,
                     shares=None,comments=8,collected_at=later,
                     count_observed_at={'shares':None,'reactions':later,'comments':later},
                     field_observed_at={'body':None,'url':None,'publication_time':None})
        f.records[1]['posts'].append(fresh)
        f.data=copy.deepcopy(f.data)
        # The list formerly shared with page 1 now also contains the new observation.
        f.data['posts']=[p for p in f.data['posts'] if p['collected_at']!=later]
        row=f.data['posts'][0];row.update(comments=8,collected_at=later,
            count_observed_at={'shares':old['collected_at'],'reactions':later,'comments':later},
            retained_fields=[{'field':key,'from_collected_at':old['collected_at'],'reason':'unavailable_in_new_observation'}
                             for key in ('url','published_at','body')])
        report=self.audit(f)
        self.assertEqual(report['validity']['status'],'valid',report['issues'])
        self.assertEqual(report['summary']['journal_reconciliation']['status'],'verified')

    def test_nonempty_terminal_duplicate_is_retained_but_not_superseded(self):
        f=self.fixture();terminal=copy.deepcopy(f.records[3]);extra=f.post(999,f.start)
        terminal.update(has_next=False,next_cursor=None,posts=[extra]);f.records.insert(3,terminal)
        f.data['posts'].append(extra);f.data['metadata']['in_range_count']+=1
        f.sync_record_audit(terminal)
        report=self.audit(f)
        self.assertEqual(report['validity']['status'],'valid')
        self.assertEqual(report['summary']['journal_reconciliation']['status'],'verified')
        self.assertEqual(report['coverage']['superseded_terminal_attempts'],0)
        self.assertFalse(report['coverage']['page_chain_verified'])

    def test_failed_only_snapshot_rows_cannot_be_official_provenance(self):
        f=self.fixture();f.records[-1].update(status='pagination_incomplete',stream_final=False)
        report=self.audit(f)
        self.assertEqual(report['validity']['status'],'invalid')
        self.assertEqual(report['summary']['journal_reconciliation']['status'],'invalid')
        self.assertEqual(report['summary']['journal_reconciliation']['failed_only_snapshot_ids'],3)
        self.assertIn('FAILED_ONLY_OBSERVATION_IN_SNAPSHOT',self.codes(report))
        self.assertFalse(report['coverage']['time_boundary_verified'])

    def test_incomplete_retry_success_keeps_failed_evidence_out_of_fields(self):
        f=self.fixture();partial=f.incomplete_before()
        partial['posts'][0].update(body='Uncommitted synthetic text',shares=777,collected_at='2025-06-13T00:00:00Z')
        partial['posts'].append(f.post(999,f.start,'Failed-only synthetic row'))
        f.sync_record_audit(partial)
        report=self.audit(f)
        self.assertEqual(report['validity']['status'],'valid',report['issues'])
        self.assertTrue(report['coverage']['page_chain_verified'])
        self.assertTrue(report['coverage']['time_boundary_verified'])
        self.assertEqual(report['coverage']['superseded_incomplete_attempts'],1)
        self.assertIn('INCOMPLETE_RETRY_SUPERSEDED',self.codes(report))
        reconciliation=report['summary']['journal_reconciliation']
        self.assertEqual(reconciliation['status'],'verified')
        self.assertEqual(reconciliation['excluded_failed_attempts'],1)
        self.assertEqual(reconciliation['excluded_failed_observations'],2)
        self.assertEqual(reconciliation['failed_only_snapshot_ids'],0)
        data=json.loads((f.output/'posts.json').read_text(encoding='utf-8'))
        self.assertNotIn('Uncommitted synthetic text',json.dumps(data))
        self.assertEqual(sum(len(data[k]) for k in module.BUCKETS),18)
        checkpoint=json.loads((f.source/'pagination-checkpoint.json').read_text(encoding='utf-8'))
        journal=''.join(Path(p).read_text(encoding='utf-8') for p in checkpoint['history_files'])
        self.assertIn('Uncommitted synthetic text',journal)
        self.assertIn('Failed-only synthetic row',journal)

    def test_unresolved_incomplete_attempt_blocks_coverage_without_poisoning_fields(self):
        f=self.fixture();partial=copy.deepcopy(f.records[-1]);partial['page']+=1
        partial.update(status='pagination_incomplete',stream_final=False,has_next=None,next_cursor=None,
                       request_cursor=f.records[-1]['next_cursor'])
        partial['posts']=partial['posts'][:1];partial['posts'][0]['shares']=777
        f.sync_record_audit(partial);f.records.append(partial)
        report=self.audit(f)
        self.assertEqual(report['validity']['status'],'valid')
        self.assertEqual(report['summary']['journal_reconciliation']['status'],'verified')
        self.assertFalse(report['coverage']['page_chain_verified'])
        self.assertEqual(report['coverage']['superseded_incomplete_attempts'],0)

    def test_retry_does_not_suppress_other_failures_or_broken_diagnostics(self):
        cases=[('response_error',lambda r:r.update(status='response_error')),
               ('http_error',lambda r:r.update(status='http_error')),
               ('access_failure',lambda r:r['audit'].update(http_status=403)),
               ('graphql_error',lambda r:r['audit'].update(errors=[{'code':1}])),
               ('parse_error',lambda r:r['audit'].update(malformed_frames=1)),
               ('rejected_story',lambda r:r['audit'].update(rejected_stories=1)),
               ('empty_unparsed',lambda r:r['audit'].update(frame_count=0)),
               ('wrong_evidence_kind',lambda r:r['audit'].update(kind='other')),
               ('boolean_diagnostic',lambda r:r['audit'].update(malformed_frames=False)),
               ('ids_mismatch',lambda r:r['audit'].update(ids=['999'])),
               ('missing_audit',lambda r:r.pop('audit')),
               ('different_cursor',lambda r:r.update(request_cursor='synthetic-other-cursor')),
               ('complete_stream',lambda r:r.update(stream_final=True)),
               ('returned_cursor',lambda r:r.update(next_cursor='synthetic-unverified-cursor'))]
        for name,mutate in cases:
            with self.subTest(name=name):
                root=self.root/name;root.mkdir();f=Fixture(root)
                partial=f.incomplete_before();mutate(partial)
                report=self.audit(f)
                self.assertFalse(report['coverage']['page_chain_verified'],name)
                self.assertEqual(report['coverage']['superseded_incomplete_attempts'],0,name)

    def test_failed_attempt_after_winner_or_short_winner_is_not_suppressed(self):
        for name in ('after_winner','short_winner','same_cursor_winner','winner_errors'):
            with self.subTest(name=name):
                root=self.root/name;root.mkdir();f=Fixture(root);partial=f.incomplete_before()
                if name=='after_winner':
                    f.records[3],f.records[4]=f.records[4],f.records[3]
                elif name=='short_winner':
                    f.records[4]['posts']=f.records[4]['posts'][:2];f.sync_record_audit(f.records[4])
                elif name=='same_cursor_winner':
                    f.records[4]['next_cursor']=f.records[4]['request_cursor']
                else:
                    f.records[4]['audit']['errors']=[{'code':1}]
                report=self.audit(f)
                self.assertFalse(report['coverage']['page_chain_verified'],name)
                self.assertEqual(report['coverage']['superseded_incomplete_attempts'],0,name)

    def test_v3_journal_version_downgrade_cannot_hide_tampering(self):
        f=self.fixture();f.records[1]['schema_version']=2
        f.data=copy.deepcopy(f.data);f.data['posts'][0]['body']='Unobserved text'
        report=self.audit(f)
        self.assertEqual(report['validity']['status'],'invalid')
        self.assertIn('JOURNAL_VERSION_MISMATCH',self.codes(report))
        self.assertIn('SNAPSHOT_JOURNAL_FIELD_MISMATCH',self.codes(report))

    def test_explicit_zero_replaces_old_count_and_older_observation_is_ignored(self):
        f=self.fixture();old=f.data['posts'][0];old['shares']=7
        fresh=copy.deepcopy(old);fresh.update(shares=0,collected_at='2025-06-12T00:00:00Z')
        fresh['count_observed_at']={key:fresh['collected_at'] for key in module.METRICS}
        f.records[1]['posts'].extend([fresh,copy.deepcopy(old)])
        f.data=copy.deepcopy(f.data)
        f.data['posts'][0]=copy.deepcopy(fresh)
        report=self.audit(f)
        self.assertEqual(report['validity']['status'],'valid',report['issues'])
        self.assertEqual(report['summary']['journal_reconciliation']['status'],'verified')

    def test_cross_batch_connection_break_blocks_coverage_not_text_validity(self):
        f=self.fixture();f.records[3]['request_cursor']='synthetic-wrong-connection'
        report=self.audit(f)
        self.assertEqual(report['validity']['status'],'valid')
        self.assertFalse(report['coverage']['time_boundary_verified'])
        self.assertIn('PAGE_CONNECTION_BROKEN',self.codes(report))

    def test_insufficient_boundary_cannot_inherit_complete_claim(self):
        report=self.audit(self.fixture(old_pages=3))
        self.assertFalse(report['coverage']['time_boundary_verified'])
        self.assertIn('CLAIMED_BOUNDARY_NOT_PROVEN',self.codes(report))

    def test_unknown_dates_and_all_nullable_fields_do_not_become_zero(self):
        f=self.fixture()
        row=f.post(999,None,None)
        row.update(shared_body=None,is_shared=True,attachment_count=None,media_types=None,
                   shares=None,reactions=None,comments=None,collected_at=None)
        f.data['undated_posts']=[row];f.data['metadata']['unknown_date_count']=1
        report=self.audit(f)
        data=json.loads((f.output/'posts.json').read_text(encoding='utf-8'))
        item=data['undated_posts'][0]
        self.assertEqual(item['classification'],'无配文分享')
        self.assertIsNone(item['body']);self.assertIsNone(item['shares']);self.assertIsNone(item['reactions']);self.assertIsNone(item['comments'])
        self.assertFalse(report['coverage']['time_boundary_verified'])
        self.assertEqual(report['validity']['status'],'valid')
        self.assertEqual(report['review']['status'],'needed')

    def test_structural_content_categories(self):
        f=self.fixture()
        f.data['posts'][0].update(body=None,media_types=['SyntheticMedia'],attachment_count=1)
        f.data['posts'][1].update(body='',media_types=[],attachment_count=1)
        f.data['posts'][2].update(body='',media_types=[],attachment_count=0)
        report=self.audit(f)
        types=report['summary']['content_types']
        self.assertEqual(types['媒体无正文'],1);self.assertEqual(types['附件无正文'],1);self.assertEqual(types['待核验'],1)
        data=json.loads((f.output/'posts.json').read_text(encoding='utf-8'))
        attachment=next(row for row in data['posts'] if row['classification']=='附件无正文')
        self.assertEqual(attachment['body'],'')
        self.assertEqual(attachment['media_types'],[])
        self.assertEqual(attachment['attachment_count'],1)

    def test_empty_shared_post_keeps_shared_body_separate(self):
        f=self.fixture();f.data['posts'][0].update(body='',shared_body='Synthetic shared original',is_shared=True)
        self.audit(f)
        data=json.loads((f.output/'posts.json').read_text(encoding='utf-8'))
        item=next(row for row in data['posts'] if row['shared_body'])
        self.assertEqual(item['body'],'');self.assertEqual(item['classification'],'无配文分享')

    def test_csv_formula_protection_json_unchanged_long_ids(self):
        f=self.fixture();f.data['posts'][0]['body']='=HYPERLINK("https://example.invalid")'
        self.audit(f)
        csv=(f.output/'posts.csv').read_text(encoding='utf-8-sig')
        self.assertIn("'=HYPERLINK",csv);self.assertIn("'900719925474099",csv)
        data=json.loads((f.output/'posts.json').read_text(encoding='utf-8'))
        self.assertIn('=HYPERLINK("https://example.invalid")',[row['body'] for row in data['posts']])

    def test_zero_missing_approximate_and_exact_count_precedence(self):
        f=self.fixture();row=f.data['posts'][0]
        row.update(shares=None,shares_raw='1.2K shares',reactions=1234,reactions_raw='1.2K',comments=0)
        self.audit(f)
        data=json.loads((f.output/'posts.json').read_text(encoding='utf-8'))
        item=next(r for r in data['posts'] if r['shares_raw'])
        self.assertEqual(item['shares'],'约 1.2K');self.assertEqual(item['reactions'],1234);self.assertEqual(item['comments'],0)

    def test_negative_count_epoch_and_url_errors_are_explicit(self):
        f=self.fixture();f.data['posts'][0]['shares']=-1
        f.data['posts'][1]['published_at_raw']+=60
        f.data['posts'][2]['url']='https://www.facebook.com/groups/synthetic-wrong/posts/999/'
        report=self.audit(f)
        self.assertEqual(report['validity']['status'],'invalid')
        self.assertTrue({'INVALID_COUNT','EPOCH_ISO_MISMATCH','URL_ID_OR_GROUP_MISMATCH'} <= self.codes(report))

    def test_malformed_record_is_placeholder_not_silent_drop(self):
        f=self.fixture();f.data['posts'].append(None);f.data['metadata']['in_range_count']=4
        report=self.audit(f)
        self.assertEqual(report['summary']['record_counts']['posts'],4)
        self.assertIn('POST_NOT_OBJECT',self.codes(report))

    def test_scope_operation_mismatch_blocks_chain(self):
        f=self.fixture();f.records[3]['operation']='wrong-operation'
        report=self.audit(f)
        self.assertFalse(report['coverage']['page_chain_verified'])
        self.assertIn('JOURNAL_SCOPE_MISMATCH',self.codes(report))

    def test_boundary_strategy_cannot_be_weakened_only_in_snapshot(self):
        f=self.fixture(old_pages=2);f.data['metadata']['required_boundary_pages']=1
        report=self.audit(f)
        self.assertFalse(report['coverage']['time_boundary_verified'])
        self.assertIn('CHECKPOINT_SCOPE_OR_VERSION_MISMATCH',self.codes(report))

    def test_terminal_retry_same_request_is_explicitly_reviewed(self):
        f=self.fixture();terminal=copy.deepcopy(f.records[3])
        terminal.update(has_next=False,next_cursor=None,posts=[])
        f.sync_record_audit(terminal)
        f.records[3:3]=[copy.deepcopy(terminal),terminal]
        report=self.audit(f)
        self.assertTrue(report['coverage']['time_boundary_verified'])
        self.assertEqual(report['coverage']['superseded_terminal_attempts'],2)
        self.assertEqual(report['review']['status'],'needed')
        self.assertIn('TERMINAL_RETRY_SUPERSEDED',self.codes(report))

    def test_terminal_retry_different_request_is_not_deduplicated(self):
        f=self.fixture();terminal=copy.deepcopy(f.records[3])
        terminal.update(has_next=False,next_cursor=None,request_cursor='synthetic-different-request',posts=[])
        f.sync_record_audit(terminal)
        f.records.insert(3,terminal)
        report=self.audit(f)
        self.assertFalse(report['coverage']['time_boundary_verified'])
        self.assertIn('JOURNAL_PAGE_REPEATED',self.codes(report))

    def test_duplicate_normal_success_is_not_deduplicated(self):
        f=self.fixture();f.records.insert(3,copy.deepcopy(f.records[3]))
        report=self.audit(f)
        self.assertFalse(report['coverage']['page_chain_verified'])

    def test_boundary_review_reason_keeps_independent_validity(self):
        f=self.fixture();f.data['metadata']['coverage_status']='date_boundary_needs_review'
        report=self.audit(f)
        self.assertTrue(report['coverage']['time_boundary_verified'])
        self.assertEqual(report['coverage']['status'],'time_boundary_needs_review')
        self.assertEqual(report['validity']['status'],'valid')
        self.assertEqual(report['review']['status'],'needed')

    def test_feed_end_keeps_last_usable_checkpoint_and_no_month_claim(self):
        f=self.fixture();f.records[-1].update(has_next=False,next_cursor=None)
        f.data['metadata']['coverage_status']='feed_end'
        report=self.audit(f)
        self.assertTrue(report['coverage']['page_chain_verified'])
        self.assertFalse(report['coverage']['time_boundary_verified'])
        self.assertEqual(report['coverage']['status'],'feed_exhausted_time_window_unverified')

    def test_truncated_history_reported_without_exposing_contents(self):
        f=self.fixture().write()
        cp=json.loads((f.source/'pagination-checkpoint.json').read_text())
        with Path(cp['history_files'][-1]).open('a') as stream:stream.write('{"incomplete":')
        report=module.export(f.source,f.output)
        self.assertIn('TRUNCATED_JOURNAL',self.codes(report));self.assertFalse(report['coverage']['page_chain_verified'])

    def test_baseline_missing_id_is_invalid_and_explicit(self):
        f=self.fixture();baseline=copy.deepcopy(f.data)
        baseline['posts'].append(f.post(888,f.start))
        path=self.root/'baseline.json';path.write_text(json.dumps(baseline))
        report=self.audit(f,baseline=path)
        self.assertIn('BASELINE_POSTS_MISSING',self.codes(report))
        self.assertEqual(report['summary']['baseline']['missing_ids'],1)

    def test_cli_standard_library_export(self):
        f=self.fixture().write()
        result=subprocess.run([sys.executable,str(SCRIPT),'--source',str(f.source),'--output',str(f.output),'--no-xlsx'],capture_output=True,text=True,encoding='utf-8')
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertEqual(json.loads(result.stdout)['target_records'],3)
        self.assertFalse((f.output/'posts.xlsx').exists())

    def test_existing_output_rejected_without_touching_files(self):
        f=self.fixture().write();f.output.mkdir()
        existing=f.output/'posts.csv';existing.write_text('existing data',encoding='utf-8')
        with self.assertRaisesRegex(ValueError,'OUTPUT_MUST_BE_NEW_OR_EMPTY'):
            module.export(f.source,f.output)
        self.assertEqual(existing.read_text(encoding='utf-8'),'existing data')
        self.assertEqual(len(list(f.output.iterdir())),1)

    def test_metric_observation_times_preserved_without_freshness_fabrication(self):
        f=self.fixture();f.data['posts'][0]['count_observed_at']['shares']='2025-06-09T12:00:00Z'
        f.data['posts'][1].pop('count_observed_at')
        report=self.audit(f)
        data=json.loads((f.output/'posts.json').read_text(encoding='utf-8'))
        by_id={row['post_id']:row for row in data['posts']}
        self.assertEqual(by_id[f.data['posts'][0]['post_id']]['count_observed_at']['shares'],'2025-06-09T12:00:00Z')
        self.assertIsNone(by_id[f.data['posts'][1]['post_id']]['count_observed_at']['shares'])
        self.assertIn('COUNT_OBSERVATION_TIME_UNAVAILABLE',self.codes(report))
        self.assertEqual(report['validity']['status'],'valid')

    def test_unknown_body_not_mislabeled_as_no_caption_media(self):
        f=self.fixture();f.data['posts'][0].update(body=None,body_known=False,attachment_count=1,media_types=['SyntheticMedia'])
        report=self.audit(f)
        self.assertIn('BODY_UNAVAILABLE',self.codes(report))
        self.assertEqual(report['summary']['content_types']['待核验'],1)

    def test_nonfinite_raw_time_and_malformed_fields_are_auditable(self):
        f=self.fixture();f.data['posts'][0].update(published_at_raw=float('nan'),shared_body={'token':'SYNTHETIC_AUTH_MARKER'},comments=False)
        report=self.audit(f)
        self.assertEqual(report['validity']['status'],'invalid')
        self.assertTrue({'INVALID_EPOCH','TEXT_FIELD_NOT_TEXT','INVALID_COUNT_TYPE'} <= self.codes(report))
        data=(f.output/'posts.json').read_text(encoding='utf-8')
        self.assertNotIn('SYNTHETIC_AUTH_MARKER',data)

    @unittest.skipUnless(importlib.util.find_spec('openpyxl'),'optional openpyxl unavailable')
    def test_xlsx_formula_safety_long_ids_and_long_unicode_text(self):
        from openpyxl import load_workbook
        f=self.fixture();long_text='=SUM(1,1)'+('😀中文'*12000)
        f.data['posts'][0]['body']=long_text
        report=self.audit(f,xlsx=True)
        self.assertEqual(report['exports']['xlsx']['status'],'written')
        workbook=load_workbook(f.output/'posts.xlsx',data_only=False)
        first=workbook['目标贴文']
        ids=[row[2].value for row in list(first.rows)[1:]]
        self.assertEqual(set(ids),{p['post_id'] for p in f.data['posts']})
        pieces=[row[5].value for row in list(workbook['长文本'].rows)[1:]]
        restored=''.join(pieces)
        self.assertEqual(restored,long_text)
        self.assertTrue(all(len(part.encode('utf-16-le'))//2<=30001 for part in pieces))
        self.assertFalse(any(cell.data_type=='f' for sheet in workbook for row in sheet for cell in row))
        with zipfile.ZipFile(f.output/'posts.xlsx') as archive:
            self.assertNotIn('SYNTHETIC_AUTH_MARKER',''.join(archive.read(name).decode('utf-8') for name in archive.namelist() if name.endswith('.xml')))

    @unittest.skipUnless(importlib.util.find_spec('openpyxl'),'optional openpyxl unavailable')
    def test_xlsx_literal_formula_prefixes_and_genuine_quotes_round_trip(self):
        from openpyxl import load_workbook
        f=self.fixture()
        values=['=SUM(1,1)','+123','-123','@name',"'genuine leading quote", "'=literal quote before equals",' \t=spaced formula']
        values.append(('A'*30000)+"'quote at the start of a later segment"+('B'*30000)+'=SUM(2,2)')
        rows=[p for bucket in module.BUCKETS for p in f.data[bucket]]
        expected={}
        for row,value in zip(rows,values):
            row['body']=value;expected[row['post_id']]=value
        report=self.audit(f,xlsx=True)
        self.assertEqual(report['exports']['xlsx']['status'],'written')
        workbook=load_workbook(f.output/'posts.xlsx',data_only=False)
        pieces={}
        for row in list(workbook['长文本'].rows)[1:]:
            pieces.setdefault(row[2].value,[]).append((row[4].value,row[5].value))
        actual={}
        for name in ('目标贴文','范围外记录'):
            for row in list(workbook[name].rows)[1:]:
                pid,body=row[2].value,row[6].value
                if pid in expected:
                    actual[pid]=''.join(text for _,text in sorted(pieces[pid])) if pid in pieces else body
        self.assertEqual(actual,expected)
        self.assertFalse(any(cell.data_type=='f' for sheet in workbook for row in sheet for cell in row))
        exported=json.loads((f.output/'posts.json').read_text(encoding='utf-8'))
        json_values={row['post_id']:row['body'] for bucket in module.BUCKETS for row in exported[bucket] if row['post_id'] in expected}
        self.assertEqual(json_values,expected)


if __name__=='__main__':
    unittest.main(verbosity=2)
