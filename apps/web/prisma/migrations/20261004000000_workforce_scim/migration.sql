CREATE SCHEMA IF NOT EXISTS fleet;
BEGIN;
SET LOCAL search_path=fleet,public;

CREATE TABLE IF NOT EXISTS fleet_workforce_scim_authority (
 application_id text NOT NULL, scope_id text NOT NULL, authority_epoch bigint NOT NULL CHECK(authority_epoch>0),
 PRIMARY KEY(application_id,scope_id)
);
CREATE TABLE IF NOT EXISTS fleet_workforce_scim_resource (
 application_id text NOT NULL, scope_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('Users','Groups')), id text NOT NULL, external_id text NOT NULL,
 document jsonb NOT NULL, revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 created timestamptz NOT NULL DEFAULT clock_timestamp(), modified timestamptz NOT NULL DEFAULT clock_timestamp(),
 revocation_epoch bigint NOT NULL DEFAULT 0 CHECK(revocation_epoch>=0), effective_grants jsonb NOT NULL DEFAULT '[]', revocation jsonb,
 PRIMARY KEY(application_id,scope_id,kind,id), UNIQUE(application_id,scope_id,kind,external_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS fleet_workforce_scim_username ON fleet_workforce_scim_resource(application_id,scope_id,lower(document->>'userName')) WHERE kind='Users';
CREATE OR REPLACE FUNCTION fleet_workforce_scim_identity_guard() RETURNS trigger AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'workforce SCIM retains identity tombstones'; END IF;
 IF NEW.application_id<>OLD.application_id OR NEW.scope_id<>OLD.scope_id OR NEW.kind<>OLD.kind OR NEW.id<>OLD.id OR NEW.external_id<>OLD.external_id THEN RAISE EXCEPTION 'workforce SCIM identity is immutable'; END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS fleet_workforce_scim_identity_guard ON fleet_workforce_scim_resource;
CREATE TRIGGER fleet_workforce_scim_identity_guard BEFORE UPDATE OR DELETE ON fleet_workforce_scim_resource FOR EACH ROW EXECUTE FUNCTION fleet_workforce_scim_identity_guard();

COMMIT;
CREATE UNIQUE INDEX usesend_workforce_account_binding ON "Account"(provider,"providerAccountId","userId");
CREATE TABLE usesend_workforce(user_id integer PRIMARY KEY REFERENCES "User"(id),issuer text NOT NULL,subject text NOT NULL,provider text NOT NULL DEFAULT 'oidc' CHECK(provider='oidc'),scope_id text NOT NULL,active boolean NOT NULL DEFAULT false,grants jsonb NOT NULL DEFAULT '[]',revocation_epoch bigint NOT NULL DEFAULT 0 CHECK(revocation_epoch>=0),UNIQUE(issuer,subject),FOREIGN KEY(provider,subject,user_id) REFERENCES "Account"(provider,"providerAccountId","userId"));
CREATE FUNCTION usesend_workforce_identity_guard() RETURNS trigger AS $$ BEGIN IF TG_OP='DELETE' OR NEW.user_id<>OLD.user_id OR NEW.issuer<>OLD.issuer OR NEW.subject<>OLD.subject OR NEW.scope_id<>OLD.scope_id OR NEW.provider<>OLD.provider THEN RAISE EXCEPTION 'workforce identity immutable';END IF;RETURN NEW;END;$$ LANGUAGE plpgsql;
CREATE TRIGGER usesend_workforce_identity_guard BEFORE UPDATE OR DELETE ON usesend_workforce FOR EACH ROW EXECUTE FUNCTION usesend_workforce_identity_guard();
