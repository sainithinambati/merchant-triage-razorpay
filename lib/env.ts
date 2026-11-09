import "server-only";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export const env = {
  supabaseUrl: () => required("SUPABASE_URL"),
  supabaseServiceKey: () => required("SUPABASE_SERVICE_ROLE_KEY"),
  anthropicKey: () => required("ANTHROPIC_API_KEY"),
  claudeModel: () => process.env.CLAUDE_MODEL || "claude-sonnet-5-5",
  claudeFastModel: () => process.env.CLAUDE_FAST_MODEL || "claude-haiku-5-5",
  webhookSecret: () => required("WEBHOOK_SECRET"),
  cronSecret: () => required("CRON_SECRET"),
  pipelineToday: () => process.env.PIPELINE_TODAY || "",
};
