/** Notices to the owner's ntfy topic, from the Worker's routes and its cron. */

export interface NotifyEnv {
  /** ntfy server root and topic; unset skips notices. */
  NTFY_URL?: string;
  NTFY_TOPIC?: string;
  /** base64 "user:password" for the ntfy server. */
  NTFY_TOKEN?: string;
}

export interface Notice {
  title: string;
  message: string;
  tags?: string[];
  /** ntfy's 1 (min) to 5 (max); 3 when unset. */
  priority?: 1 | 2 | 3 | 4 | 5;
  /** Opened when the notice is tapped. */
  click?: string;
}

/**
 * Posts a notice when ntfy is configured. Never rejects: failures are only
 * logged, so a notice can't fail the work that sent it.
 */
export async function notify(env: NotifyEnv, notice: Notice): Promise<void> {
  if (!env.NTFY_URL || !env.NTFY_TOPIC || !env.NTFY_TOKEN) return;
  try {
    // ntfy's JSON form, so non-ASCII titles survive (headers can't carry them).
    const res = await fetch(env.NTFY_URL, {
      method: "POST",
      headers: {
        authorization: `Basic ${env.NTFY_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ topic: env.NTFY_TOPIC, ...notice }),
    });
    if (!res.ok) console.error(`ntfy: HTTP ${res.status} ${await res.text()}`);
  } catch (error) {
    console.error("ntfy:", error);
  }
}
