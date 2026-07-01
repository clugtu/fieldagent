# FieldAgent — Open Questions

These are unresolved product and architecture decisions. Answer them before
committing to work that depends on the answer.

---

## 1. Distribution model — extension

**Question:** Should FieldAgent be one generic extension on the Chrome Web
Store that anyone configures to point at their own service instance? Or
should different platforms ship their own branded extensions (e.g. a
"MiniForge Assistant" extension that happens to be built on FieldAgent)?

**Why it matters:** Affects how the extension handles auth (one shared
key store vs per-brand isolation), how it gets discovered, and whether
the extension codebase is meant to be forked or consumed as a dependency.

**Options:**
- Generic extension — one listing, users self-configure service URL + key
- White-label — platforms fork and brand their own version
- SDK approach — FieldAgent ships as an npm package that platforms bundle into their own extension

---

## 2. Distribution model — service

**Question:** Is the service something every user runs themselves (self-hosted),
or do we run a hosted instance that anyone connects to?

**Why it matters:** Self-hosted means each user needs a server and an
Anthropic key. Hosted means we manage multi-tenancy, billing, and the LLM
cost — but anyone can use the extension without running anything themselves.

**Options:**
- Self-hosted only (current model)
- Hosted SaaS at fieldagent.io (or similar)
- Hybrid — open source self-hosted, plus a managed tier

---

## 3. Multi-tenancy

**Question:** If the service is hosted, can multiple users share one instance?
Or is it always one service per user / team?

**Why it matters:** Multi-tenancy requires task queues scoped to users,
per-user API keys, and careful isolation. Single-tenant is simpler but
requires each user to deploy their own.

---

## 4. Business model

**Question:** Free and open source? Freemium? Per-task billing?

**Options:**
- Fully open source, self-hosted, no hosted tier
- Open source + paid hosted tier (like Plausible, Sentry, etc.)
- Per-task billing on the hosted tier

---

## 5. LLM flexibility

**Question:** Is Claude the only supported LLM, or should users be able
to bring their own (OpenAI, local models, etc.)?

**Why it matters:** LangChain makes swapping trivial technically, but
supporting multiple LLMs adds testing surface. Claude is the current
assumption throughout the codebase.

---

## 6. Platform for others to build on

**Question:** Is FieldAgent a finished product, or a platform / framework
that other developers build form-automation on top of?

**Why it matters:** If it's a platform, the API design needs to be stable
and documented as a public interface. The service needs webhooks, SDKs,
and versioning. If it's a product, those concerns are secondary.

**Options:**
- Product — FieldAgent does one thing well, not designed to be extended
- Platform — stable API, Python/JS SDKs, webhook callbacks, versioning
- Both — product-grade UX for end users, platform-grade API for developers

---

## 7. Onboarding experience

**Question:** What is the zero-to-working experience for a new user?

Currently: install extension, run service locally, paste API key into
settings. That's three manual steps before anything works, with no
guidance if any of them fail (as we've already seen — no configured
state message in the extension).

**Options:**
- Keep current model, just make the failure states obvious
- Hosted service removes the "run the service" step entirely
- Browser-based setup wizard that walks through config and verifies connection
