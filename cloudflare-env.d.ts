declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    OPENAI_API_KEY?: string;
    FACULTY_DESK_LOCAL_ONLY?: string;
    OPENAI_RESEARCH_MODEL?: string;
    BUCKET?: R2Bucket;
  }
}
