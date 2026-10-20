"""Extend the retained three-system fixture; never use production credentials.

Requires explicit local Flow/Memory roots and the disposable ProcessStack DSNs.
The 300-profile provider is synthetic. Memory and Flow are real local services.
This is separate from the virtual-clock ten-minute PostgreSQL regression.
"""
import hashlib
import os
import sys
from pathlib import Path

flow = Path(os.environ["ACTIVEKG_INDEX_XS_FLOW_ROOT"]) / "VantaHireWebsite"
source = flow / "test/integration/governed-sourcing-process.test.ts"
raw = source.read_text()
assert hashlib.sha256(raw.encode()).hexdigest() == (
    "219db9db0d26a1a4c9640716196755837e89eb2be5b2ea31b8ff476fd50b794b"
), "retained fixture changed; review before adapting"
start = raw.index("import os,sys,json,time,hashlib")
script = raw[start:raw.index("\n`;", start)]


def replace(old, new, count=1):
    global script
    assert script.count(old) == count, ("fixture boundary changed", old[:100])
    script = script.replace(old, new)


replace("'== 32'", "'== 37'")
replace("result.applied.length!==18", "result.applied.length!==23")
replace("'schemaVersion':3,'compilerVersion':3,'taxonomyVersion':3",
        "'schemaVersion':4,'compilerVersion':4,'taxonomyVersion':4")
replace("['2020-01-01','2015-01-01','2005-01-01',null].map",
        "Array.from({length:300},()=> '2020-01-01').map")
# Real Memory requests still run through the retained loopback/TLS fence.
replace("if(url.hostname==='127.0.0.1'){",
        "if(url.hostname==='127.0.0.1'){\n"
        "  if(url.pathname==='/sourced-candidates/ingest')"
        "await new Promise(r=>setTimeout(r,2500));")
replace("fetchone()[0]==2\n                        assert discover",
        "fetchone()[0]==100\n                        assert discover")
replace("fetchone()[0]==4", "fetchone()[0]==300", count=3)
replace(")==4,calls", ")==300,calls")
replace(")==4\n", ")==300\n")
replace("!=4:", "!=300:")
replace("['processed']==4", "['processed']==300")
replace("[('in_range',),('wider',)]", "[('in_range',)]*100")
replace("seconds=120)", "seconds=600)", count=1)
replace("cache_deadline=time.monotonic()+75", "cache_deadline=time.monotonic()+300")

# The retained fixture predates immutable contract-2 and artificially restores a
# deleted raw purchase. That is now correctly forbidden. Exercise maintenance
# against the sealed, acknowledged contract instead; process restart remains
# below and the PG suite separately covers lost acknowledgements.
first = script.index("                    # Reproduce the durable receipt/ack crash gap.")
last = script.index("                assert self.forbidden.read_text()==''", first)
script = script[:first] + '''                    before_order=discover.execute('SELECT candidate_id,selected_ordinal FROM governed_ranking_items WHERE tenant_id=%s ORDER BY candidate_id',(tenant,)).fetchall()
                    assert discover.execute("SELECT count(*) FROM public_memory_ingest_requests p JOIN crustdata_acquisition_receipts a ON a.id=p.acquisition_id WHERE a.\\"tenantId\\"=%s AND p.state='succeeded'",(tenant,)).fetchone()[0]==300
                    self.run(['node','scripts/rc-skills-maintenance.mjs','--once'],de,self.discover,timeout=90)
                    assert discover.execute('SELECT candidate_id,selected_ordinal FROM governed_ranking_items WHERE tenant_id=%s ORDER BY candidate_id',(tenant,)).fetchall()==before_order
                    assert discover.execute('SELECT count(*) FROM crustdata_acquisition_receipts WHERE "tenantId"=%s',(tenant,)).fetchone()[0]==1
''' + script[last:]

# No UI behavior is changed in this package. Use the same signed-in recruiter
# HTTP commands and read the resulting real Flow rows/API instead of browser UX.
first = script.index("                def browser(phase):")
last = script.index("                browser('before')", first)
script = script[:first] + '''                def browser(phase):
                    if phase=='confirm':
                        current=quote()
                        command={k:current[v] for k,v in {
                            'expectedRevision':'revision','briefVersionId':'briefVersionId',
                            'materialHash':'materialHash','artifactId':'artifactId',
                            'expectedPayerSlotId':'payerSlotId','expectedWindowStart':'windowStart',
                            'quoteToken':'quoteToken'}.items()}
                        command['requestId']=str(uuid4())
                        admitted=self.post(client,f'/api/jobs/{job}/find-candidates',json=command)
                        assert admitted.status_code in (200,202),(admitted.status_code,admitted.text)
                        self.file('browser-confirm.json.command.json',json.dumps(command))
                    elif phase not in ('before',):
                        response=client.get(f'/api/jobs/{job}/sourced-candidates')
                        assert response.status_code==200
''' + script[last:]
# Direct-publish is explicit and local; saving/approving a brief stays private.
replace("assert approval.status_code==200,(approval.status_code,approval.text)",
        "assert approval.status_code==200,(approval.status_code,approval.text)\n"
        "                published=client.patch(f'/api/jobs/{job}/status',headers=self.csrf(client),json={'isActive':True,'requestId':str(uuid4()),'expectedRevision':2})\n"
        "                assert published.status_code==200,(published.status_code,published.text)")

# Reproduce the old progress-clock condition while genuine ingestion is active.
# Backdating is confined to synthetic rows; no product clock or watchdog is mocked.
replace("                failed=os.environ.get('FIXTURE_ACQUISITION_FAIL')=='1'",
        '''                self.wait(lambda: discover.execute(
                    "SELECT count(*) FROM crustdata_acquisition_receipts WHERE \\"tenantId\\"=%s AND memory_prepared_at IS NOT NULL",
                    (tenant,)).fetchone()[0]==1,seconds=120)
                discover.execute("UPDATE rc_sourcing_runs SET last_progress_at=clock_timestamp()-interval '180 seconds' WHERE tenant_id=%s",(tenant,))
                self.run(['node','scripts/rc-skills-maintenance.mjs','--once'],de,self.discover,timeout=90)
                assert discover.execute("SELECT state FROM rc_sourcing_runs WHERE tenant_id=%s",(tenant,)).fetchone()[0]!='stalled'
                print('MEMORY_WAIT_WATCHDOG_WITH_REAL_SERVICES_PASS',flush=True)
                failed=os.environ.get('FIXTURE_ACQUISITION_FAIL')=='1' '''.rstrip())

os.environ.update(FIXTURE_RC="1", FIXTURE_RC_RESUME="0", FIXTURE_ACQUISITION_FAIL="2")
compiled = compile(script, str(source) + ":memory-wait-extension", "exec")
if "--check" in sys.argv:
    print("CROSS_SYSTEM_FIXTURE_COMPILES")
else:
    exec(compiled)
