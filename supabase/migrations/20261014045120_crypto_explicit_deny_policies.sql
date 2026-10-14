-- These tables are private service-role storage. Explicit deny policies document
-- the intended default-deny posture for every non-bypass role.
CREATE POLICY crypto_settings_private_deny ON karma_internal.crypto_settings
  FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY crypto_assets_private_deny ON karma_internal.crypto_assets
  FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY crypto_providers_private_deny ON karma_internal.crypto_providers
  FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY crypto_checkpoints_private_deny ON karma_internal.crypto_checkpoints
  FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY crypto_scan_invocations_private_deny ON karma_internal.crypto_scan_invocations
  FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY crypto_scan_runs_private_deny ON karma_internal.crypto_scan_runs
  FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY crypto_observations_private_deny ON karma_internal.crypto_observations
  FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY crypto_attribution_claims_private_deny ON karma_internal.crypto_attribution_claims
  FOR ALL TO public USING (false) WITH CHECK (false);
