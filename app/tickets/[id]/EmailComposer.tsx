"use client";

// The app never sends email. The agent checks the reply here, then copies it or opens it
// in their own mail app, sends it, and clicks "Mark as sent".
import { useActionState, useState, useTransition } from "react";
import { checkBeforeSending, markAsSent, saveDraft, type ActionState } from "./actions";

interface Props {
  id: string;
  to: string;
  subject: string;
  draft: string;
  closed: boolean;
  sentNote?: string;
}

export default function EmailComposer({ id, to: initialTo, subject: initialSubject, draft, closed, sentNote }: Props) {
  const [to, setTo] = useState(initialTo);
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState(draft);
  const [override, setOverride] = useState(false);
  const [local, setLocal] = useState<ActionState>({});
  const [checking, startCheck] = useTransition();
  const [sentState, sendAction, marking] = useActionState<ActionState, FormData>(markAsSent, {});
  const [saveState, saveAction, saving] = useActionState<ActionState, FormData>(saveDraft, {});
  const state = sentState.ok || sentState.error ? sentState : local.ok || local.error ? local : saveState;

  const fullText = `To: ${to}\nSubject: ${subject}\n\n${body}`;
  const mailto = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  function checked(then: () => void) {
    startCheck(async () => {
      const res = await checkBeforeSending(id, body, override);
      setLocal(res.error ? res : { ...res, ok: undefined });
      if (!res.error) then();
    });
  }

  if (closed) {
    return (
      <div>
        <dl className="kv"><dt>To</dt><dd>{to || "(not recorded)"}</dd><dt>Subject</dt><dd>{subject}</dd></dl>
        <pre className="msg" style={{ marginTop: 12 }}>{body}</pre>
        {sentNote && <p className="note">{sentNote}</p>}
      </div>
    );
  }

  return (
    <form>
      <input type="hidden" name="id" value={id} />
      <label>To</label>
      <input name="to" type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="merchant@example.com" />
      <label>Subject</label>
      <input name="subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
      <label>Message</label>
      <textarea name="reply" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write the reply..." />

      {state.error && <div className="alert">{state.error}</div>}
      {state.ok && <div className="alert ok">{state.ok}</div>}
      {!!state.blocking?.length && (
        <div className="alert"><strong>Output check</strong><ul className="list">{state.blocking.map((b) => <li key={b}>{b}</li>)}</ul></div>
      )}
      {!!state.warnings?.length && (
        <div className="alert warn"><ul className="list">{state.warnings.map((b) => <li key={b}>{b}</li>)}</ul></div>
      )}

      <label style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--text)" }}>
        <input type="checkbox" name="override" checked={override} onChange={(e) => setOverride(e.target.checked)} style={{ width: "auto" }} />
        I have checked the facts myself (override soft output-check blocks)
      </label>

      <div className="row">
        <button type="button" disabled={checking || !body.trim()}
          onClick={() => checked(async () => {
            try { await navigator.clipboard.writeText(fullText); setLocal({ ok: "Copied. Paste it into your mail app, send it, then click Mark as sent." }); }
            catch { setLocal({ error: "Could not copy. Select the text and copy it manually." }); }
          })}>
          {checking ? "Checking..." : "Copy email"}
        </button>
        <button type="button" disabled={checking || !body.trim() || !to}
          onClick={() => checked(() => { window.location.href = mailto; setLocal({ ok: "Opened in your mail app. Send it there, then click Mark as sent." }); })}>
          Open in mail app
        </button>
        <button className="primary" formAction={sendAction} disabled={marking || !body.trim()}>{marking ? "Saving..." : "Mark as sent"}</button>
        <button formAction={saveAction} disabled={saving}>{saving ? "Saving..." : "Save draft"}</button>
      </div>
      <p className="note">The app does not send email. Every action above re-checks the message against the fact sheet first.</p>
    </form>
  );
}
