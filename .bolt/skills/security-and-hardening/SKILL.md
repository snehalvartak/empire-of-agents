---
name: security-and-hardening
description: Security rules for this app's real attack surface — the browser talking directly to the database with row-level access rules, the AI proxy edge function holding the provider key, and viewer-editable settings. Use whenever adding or changing tables, access policies, the agent-brain proxy, form inputs, stored settings, or anything a viewer or an AI reply could influence. Trigger on "secure", "auth", "API key", "input", "settings", "policy", or any new table or data flow, even if the user doesn't use the word security.
---

# Security and Hardening

This app has no sign-in: the browser talks to Supabase with the public anon key, and one server-side edge function (`supabase/functions/agent-brain`) proxies requests to the AI provider while holding the secret key. That shapes every rule below. The viewer's browser is untrusted, and so is every character that comes out of the language model.

## Database access

- Every new table gets row-level security enabled in the same migration that creates it, plus explicit grants only to the roles that actually need each verb. A table locked by policies but missing a grant fails with a permission error; a table with grants but no policy is wide open to the internet. Check both, every time.
- This is a no-auth app, so read policies scoped `TO anon, authenticated` with a `USING (true)` predicate are legitimate for genuinely public data (the world, the feed). Anything a viewer writes — settings, flags, marked entries — must be validated by a `WITH CHECK` predicate or a server-side function, not accepted blind.
- Never give the anon role access to a column it shouldn't set. If a table mixes public data and privileged columns (role, balance, moderation state, internal flags), split the writes or use a security-definer function so the browser can never write the privileged part directly.
- Views inherit the rights of their owner by default and can silently bypass row-level security. If you create a view over restricted data, make it security-invoker or grant it deliberately.

## The AI proxy

- The provider key lives only in edge function secrets. Never import it, log it, or reference it in browser code; never move the AI call client-side to "simplify" things.
- The proxy allowlists what the browser may send: model name from a fixed list, prompt assembled server-side. A request body field that reaches the provider unchecked is an injection and a cost vector.
- Sanitize the model's reply before it drives anything: it is untrusted input, not a teammate. Parse it against a strict schema, clamp numbers, reject unknown action names, cap lengths. A malformed or malicious reply must degrade to a safe default (the villager idles), never wedge the simulation or inject content into the DOM.
- Return generic errors to the client. Detailed provider errors go to the function logs, not the browser.

## Input handling

- Anything a viewer types or picks — names, model choice, filter text — is attacker-controlled. Validate against allowlists at the boundary where it enters the system, not at the point of use.
- React escapes text by default, so the main injection risks are the places we opt out: `dangerouslySetInnerHTML` (don't use it for anything user- or model-derived), URLs built from strings (validate the scheme), and identifiers used in queries (parameterize — the client library does this automatically; raw SQL strings don't).
- Settings persisted in the browser's local storage are viewer-local and low stakes, but still wrap reads in try/catch and validate the shape — corrupted or hand-edited values must fall back to defaults.

## Example

A new "viewer can rename a villager" feature. Wrong: write the name straight from the browser into the agents table with an open update policy — one viewer renames every villager on the island, or writes a 10KB string that breaks the 3D label. Right: an update policy that only allows the intended rows, a length cap and character allowlist enforced server-side (a check constraint or a security-definer function), and the 3D label renderer treating the stored name as untrusted text of bounded length.

## Before finishing

For any change that touches data access, run the database security advisor and read the actual policies — a clean build proves nothing about access control, because access rules live in the database, not the code.
