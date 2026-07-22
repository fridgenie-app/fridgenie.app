// Jujube admin — public client configuration.
// Both values below are SAFE to expose in the browser:
//   • SUPABASE_URL is public.
//   • PUBLISHABLE_KEY is the new-format publishable (anon) key — RLS still
//     applies, and every privileged read/write goes through the is_admin()-gated
//     `admin-console` Edge Function using the server-side service role.
// The service-role / secret key is NEVER present in this repo.
window.JUJUBE_ADMIN_CONFIG = {
  SUPABASE_URL: "https://rhhaojpsqfbapltcvsbz.supabase.co",
  PUBLISHABLE_KEY: "sb_publishable__x55NQolA1av3A2J0SGYwQ_PZh1FvOH",
  // Edge Function base. Defaults to <SUPABASE_URL>/functions/v1/admin-console.
  FUNCTION_NAME: "admin-console",
};
