import io
import json
import os
from datetime import datetime, timezone
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import r2_usage_guard as guard
import r2_store

NOW=datetime(2026,10,9,2,0,tzinfo=timezone.utc)
ENV={'CLOUDFLARE_R2_ANALYTICS_TOKEN':'dummy-test-only','R2_BILLING_DAY':'8',
     'R2_ENDPOINT':'https://'+'a'*32+'.r2.cloudflarestorage.com',
     'R2_ACCESS_KEY_ID':'test','R2_SECRET_ACCESS_KEY':'test','R2_BUCKET':'test'}

class UsageGuardTests(unittest.TestCase):
 def setUp(self):
  self.enterContext(patch.dict(os.environ,ENV,clear=True))
  self.enterContext(patch.object(guard,'_cached',None))
  self.enterContext(patch.object(guard,'_checked',0))

 def test_exact_thresholds_and_account_cycle(self):
  with patch.object(guard,'usage',return_value={'classA':949999,'classB':9699999}):
   self.assertFalse(guard.decision(NOW,{})['paused'])
  for counts in [{'classA':950000,'classB':0},{'classA':0,'classB':9700000}]:
   with patch.object(guard,'usage',return_value=counts):state=guard.decision(NOW,{})
   self.assertTrue(state['paused']);self.assertEqual(state['reason'],'operations_limit')
   self.assertEqual(state['period'],'2026-10-08')
   self.assertEqual(state['until'],int(datetime(2026,11,8,tzinfo=timezone.utc).timestamp()))

 def test_cutoff_latches_and_resets_only_at_next_billing_cycle(self):
  old={'version':1,'enabled':True,'paused':True,'reason':'operations_limit','period':'2026-10-08','until':int(datetime(2026,11,8,tzinfo=timezone.utc).timestamp())}
  with patch.object(guard,'usage',return_value={'classA':0,'classB':0}) as usage:
   self.assertEqual(guard.decision(NOW,old),old);usage.assert_not_called()
   next_cycle=guard.decision(datetime(2026,11,8,tzinfo=timezone.utc),old)
   self.assertFalse(next_cycle['paused']);self.assertEqual(next_cycle['period'],'2026-11-08')

 def test_month_end_and_leap_year_billing_dates(self):
  start,end=guard.period(datetime(2028,2,29,1,tzinfo=timezone.utc),31)
  self.assertEqual(start.day,29);self.assertEqual(end.day,31);self.assertEqual(end.month,3)
  start,end=guard.period(datetime(2026,1,1,tzinfo=timezone.utc),8)
  self.assertEqual(start.date().isoformat(),'2025-12-08');self.assertEqual(end.date().isoformat(),'2026-01-08')

 def test_manual_pause_does_not_activate_an_unconfigured_automatic_guard(self):
  with patch.dict(os.environ,{'R2_PAUSED':'true','CLOUDFLARE_R2_ANALYTICS_TOKEN':''}):
   state=guard.decision(NOW,{})
  self.assertTrue(state['paused']);self.assertFalse(state['enabled'])
  with patch.dict(os.environ,{'CLOUDFLARE_R2_ANALYTICS_TOKEN':''}):
   self.assertFalse(guard.decision(NOW,state)['paused'])

 def test_telemetry_failures_and_incomplete_configuration_fail_closed(self):
  with patch.object(guard,'usage',side_effect=RuntimeError('partial analytics')):
   self.assertEqual(guard.decision(NOW,{})['reason'],'analytics_unavailable')
  with patch.dict(os.environ,{'R2_BILLING_DAY':''}):self.assertTrue(guard.decision(NOW,{})['paused'])
  with patch.dict(os.environ,{'CLOUDFLARE_R2_ANALYTICS_TOKEN':''}):
   self.assertFalse(guard.decision(NOW,{})['enabled'])
   self.assertTrue(guard.decision(NOW,{'enabled':True})['paused'])

 def test_account_wide_totals_classify_actions_and_exclude_free_deletes(self):
  rows=[{'dimensions':{'actionType':name},'sum':{'requests':n}} for name,n in [('PutObject',950000),('get_object',9700000),('DeleteObjects',99999999)]]
  payload={'data':{'viewer':{'accounts':[{'r2OperationsAdaptiveGroups':rows}]}}}
  with patch.object(guard.urllib.request,'urlopen',return_value=io.BytesIO(json.dumps(payload).encode())) as read:
   counts=guard.usage(NOW,datetime(2026,10,8,tzinfo=timezone.utc))
  self.assertEqual(counts,{'classA':950000,'classB':9700000})
  query=json.loads(read.call_args.args[0].data)
  self.assertNotIn('bucketName',query['query'])
  self.assertEqual(query['variables']['start'],'2026-10-08T00:00:00+00:00')
  self.assertEqual(read.call_args.args[0].full_url,guard.API)

 def test_partial_or_unknown_analytics_cannot_be_treated_as_zero(self):
  payload={'errors':[{'message':'rate limit'}],'data':{}}
  with patch.object(guard.urllib.request,'urlopen',return_value=io.BytesIO(json.dumps(payload).encode())):
   with self.assertRaises(ValueError):guard.usage(NOW,NOW)
  payload={'data':{'viewer':{'accounts':[{'r2OperationsAdaptiveGroups':[{'dimensions':{'actionType':'GetBucketSippyConfiguration'},'sum':{'requests':3}}]}]}}}
  with patch.object(guard.urllib.request,'urlopen',return_value=io.BytesIO(json.dumps(payload).encode())):
   self.assertEqual(guard.usage(NOW,NOW),{'classA':3,'classB':3})

 def test_before_call_guard_stops_a_running_batch_on_next_recheck(self):
  with patch.object(guard,'decision',side_effect=[{'paused':False},{'paused':True,'reason':'operations_limit'}]),patch.object(guard.time,'monotonic',side_effect=[100,110,161,161]):
   guard.ensure_allowed();guard.ensure_allowed()
   with self.assertRaises(guard.BudgetPaused):guard.ensure_allowed()

 def test_paused_client_does_not_open_an_r2_connection(self):
  fake=types.SimpleNamespace(client=Mock())
  with patch.dict(sys.modules,{'boto3':fake}),patch.object(guard,'decision',return_value={'paused':True,'reason':'operations_limit'}):
   with self.assertRaises(guard.BudgetPaused):r2_store.connect()
  fake.client.assert_not_called()

 def test_client_checks_every_s3_call_including_paginator_requests(self):
  client=Mock();fake=types.SimpleNamespace(client=Mock(return_value=client))
  config=types.SimpleNamespace(Config=lambda **kwargs:None)
  with patch.dict(sys.modules,{'boto3':fake,'botocore.config':config}),patch.object(guard,'decision',return_value={'paused':False}):
   result,bucket=r2_store.connect()
  self.assertIs(result,client);self.assertEqual(bucket,'test')
  client.meta.events.register.assert_called_once_with('before-call.s3',guard.ensure_allowed)

if __name__=='__main__':unittest.main()
