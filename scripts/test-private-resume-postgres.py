"""Synthetic, rollback-only identity/contact tests on an explicitly disposable DB."""
import json
import os
from pathlib import Path
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb

dsn = os.environ.get("PRIVATE_RESUME_TEST_DSN", "")
if os.environ.get("PRIVATE_RESUME_DISPOSABLE") != "1" or not dsn:
    raise RuntimeError("Explicit disposable test configuration required")

checks = 0


def check(value):
    global checks
    assert value
    checks += 1


with psycopg.connect(dsn) as db:
    database, owner, superuser, bypass = db.execute(
        "SELECT current_database(),current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user"
    ).fetchone()
    if not database.startswith("resume_discover_") or not database.endswith("_test") or superuser or bypass:
        raise RuntimeError("Refuse non-disposable or privileged database")
    if os.environ.get("PRIVATE_RESUME_TEST_INIT") == "1":
        # CI owns a fresh database; never reset or overwrite an existing schema.
        if db.execute("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') LIMIT 1").fetchone():
            raise RuntimeError("Refuse initialization of nonempty database")
        root = Path(__file__).resolve().parents[1]
        through = json.loads((root / "prisma/baseline/manifest.json").read_text())["baselineMigrationThrough"]
        db.execute((root / "prisma/baseline/signal-baseline.sql").read_text())
        for migration in sorted((root / "prisma/migrations").glob("*/migration.sql")):
            if migration.parent.name > through:
                db.execute(migration.read_text())
        db.commit()
    db.execute("SET LOCAL statement_timeout='5s'")
    db.execute("SET LOCAL lock_timeout='1s'")
    db.execute("GRANT USAGE ON SCHEMA public TO signal_runtime")
    # Reproduce broad provisioning, then its explicit protected-table closure.
    db.execute("GRANT SELECT,INSERT,UPDATE,DELETE ON private_candidate_sources TO signal_runtime")
    db.execute("REVOKE ALL ON private_candidate_sources FROM signal_runtime,PUBLIC")
    db.execute("GRANT EXECUTE ON FUNCTION signal_private_candidate_materialize(text,jsonb) TO signal_runtime")
    db.execute("GRANT EXECUTE ON FUNCTION signal_private_contact_allowed(text,text) TO signal_runtime")
    check(not db.execute("SELECT has_table_privilege('signal_runtime','private_candidate_sources','SELECT')").fetchone()[0])
    check(not db.execute("SELECT has_table_privilege('signal_runtime','private_candidate_sources','INSERT')").fetchone()[0])

    identity = {key: str(uuid4()) for key in ["candidateId", "referenceId", "resumeVersionId", "sourceId", "generationId"]}
    identity.update(applicationId=123, applicationJobId=188, sourceHash="a" * 64)
    payload = {"identity": identity, "linkedPublicId": None, "observedAt": "2026-10-17T00:00:00Z"}

    def materialize(tenant="org_32", value=None):
        return db.execute("SELECT signal_private_candidate_materialize(%s,%s)",
                          (tenant, Jsonb(payload if value is None else value))).fetchone()[0]

    candidate = materialize()
    check(materialize() == candidate)
    check(materialize("org_5") != candidate)
    check(db.execute('SELECT "identityKind","linkedinId","linkedinUrl" FROM candidates WHERE id=%s',
                     (candidate,)).fetchone() == ("organization_candidate", None, None))
    check(db.execute("SELECT count(*) FROM private_candidate_sources WHERE candidate_id=%s", (candidate,)).fetchone()[0] == 1)
    check(db.execute("SELECT signal_private_contact_allowed('org_32',%s)", (candidate,)).fetchone()[0] is False)
    check(db.execute("SELECT signal_private_contact_allowed('org_5',%s)", (candidate,)).fetchone()[0] is False)
    evidence={"candidateId":candidate,"version":"rubric-evidence-v2","resumeIdentity":identity}
    check(db.execute("SELECT signal_private_evidence_bound('org_32',%s)",(Jsonb(evidence),)).fetchone()[0] is True)
    check(db.execute("SELECT signal_private_evidence_bound('org_5',%s)",(Jsonb(evidence),)).fetchone()[0] is False)
    check(db.execute("SELECT signal_private_evidence_bound('org_32',%s)",
                     (Jsonb({**evidence,"resumeIdentity":{**identity,"sourceHash":"b"*64}}),)).fetchone()[0] is False)
    check(db.execute("SELECT signal_private_evidence_bound('org_32',%s)",
                     (Jsonb({"candidateId":candidate,"version":"rubric-evidence-v1"}),)).fetchone()[0] is False)
    for assignment in ['"identityKind"=\'linkedin\'','"privateCandidateRef"=gen_random_uuid()', '"tenantId"=\'org_99\'']:
        try:
            with db.transaction():
                db.execute('UPDATE candidates SET '+assignment+' WHERE id=%s',(candidate,))
        except psycopg.Error:
            check(True)
        else:
            raise AssertionError('Private identity was mutable')

    for mutation in [
        {**payload, "identity": {**identity, "sourceHash": "b" * 64}},
        {**payload, "email": "synthetic@example.invalid"},
        {**payload, "identity": {**identity, "candidateId": "00000000-0000-0000-0000-000000000000"}},
        {**payload, "identity": None},
        {**payload, "observedAt": "infinity"},
    ]:
        try:
            with db.transaction():
                materialize(value=mutation)
        except psycopg.Error:
            check(True)
        else:
            raise AssertionError("Invalid or changed provenance accepted")

    public_id = str(uuid4())
    db.execute('INSERT INTO candidates (id,"tenantId","linkedinId","linkedinUrl","captureSource","createdAt","updatedAt") '
               "VALUES (%s,'org_32','synthetic-public','https://www.linkedin.com/in/synthetic-public','test',now(),now())", (public_id,))
    check(db.execute("SELECT signal_private_contact_allowed('org_32',%s)", (public_id,)).fetchone()[0] is True)
    check(db.execute("SELECT signal_private_contact_allowed('org_5',%s)", (public_id,)).fetchone()[0] is False)
    check(db.execute("SELECT signal_private_contact_allowed('org_32','missing')").fetchone()[0] is False)

    # All fixtures and test grants disappear; never commit a synthetic applicant.
    db.rollback()
print(json.dumps({"passed": checks, "synthetic": True, "rolled_back": True}))
