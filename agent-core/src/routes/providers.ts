// ─────────────────────────────────────────────────────────────────────────────
// R84 (Wave 2-a): the providers + provider-keys domain (API.md §8).
//
// Registers, in the original server.ts registration order: GET /providers,
// POST /providers, PATCH /providers/:id, DELETE /providers/:id,
// GET /providers/:id/models, POST /providers/:id/test, GET
// /providers/:id/models-config, POST /providers/:id/models (the upsert),
// PUT /providers/:id/key (the primary key), and the ROUND-36/47/58 key-pool
// routes: GET /providers/:id/keys, POST /providers/:id/keys/reveal, PUT
// /providers/:id/keys/:slot, DELETE /providers/:id/keys/:slot. Keys never
// appear in any response except the owner-directed reveal route (R58-d).
//
// Provenance: extracted verbatim from server.ts in R84 (Wave 2-a) —
// behavior-identical, test-guarded. The model-config field validators are
// exported by routes/models.ts (the R50-d gate both files share).
// ─────────────────────────────────────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.js";
import {
  ProviderTestError,
  fetchProviderModels,
  listProviderViews,
  resolveKeyPool,
  resolveProvider,
  testProviderConnection,
} from "../providers/registry.js";
import {
  RESERVED_PROVIDER_IDS,
  clearProviderTombstone,
  createProviderRecord,
  deleteProviderRecord,
  getProviderRecord,
  providerRecordIdExists,
  slugifyProviderId,
  updateProviderRecord,
} from "../storage/providers.js";
import {
  listModels,
  upsertModel,
} from "../storage/models.js";
import { listAgents, resetAgentsProvider } from "../storage/agents.js";
import { errorBody } from "./helpers.js";
// R84 (Wave 2-a): the shared R50-d model-config field gate (exported by
// routes/models.ts — the upsert + PATCH routes validate identically).
import { readModelNumericFields, readModelScalarFields, readTriStateField, isModelTriStateField } from "./models.js";

export function registerProviderRoutes(scope: FastifyInstance, ctx: RouteContext): void {
  const { db, keyring } = ctx;
  // ---- Providers (API.md §8) ---- keys never appear in any response.

  scope.get("/providers", async () => {
    return { providers: listProviderViews(db, keyring) };
  });

  scope.post("/providers", async (request, reply) => {
    const body: unknown = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return reply
        .code(400)
        .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
    }
    const raw = body as Record<string, unknown>;

    if (typeof raw.name !== "string" || raw.name.trim() === "") {
      return reply
        .code(400)
        .send(errorBody("VALIDATION", "name must be a non-empty string", { field: "body.name" }));
    }
    let baseUrl: URL;
    if (typeof raw.baseUrl !== "string") {
      return reply.code(400).send(
        errorBody("VALIDATION", "baseUrl must be a http(s) URL string", {
          field: "body.baseUrl",
        }),
      );
    }
    try {
      baseUrl = new URL(raw.baseUrl);
    } catch {
      return reply.code(400).send(
        errorBody("VALIDATION", "baseUrl must be a valid URL", { field: "body.baseUrl" }),
      );
    }
    if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
      return reply.code(400).send(
        errorBody("VALIDATION", "baseUrl must use http or https", { field: "body.baseUrl" }),
      );
    }

    let id = slugifyProviderId(raw.name);
    if (raw.id !== undefined) {
      if (typeof raw.id !== "string" || raw.id.trim() === "") {
        return reply.code(400).send(
          errorBody("VALIDATION", "id must be a non-empty string", { field: "body.id" }),
        );
      }
      id = raw.id.trim();
    }
    if (id === "") {
      return reply.code(400).send(
        errorBody("VALIDATION", `id is reserved or unusable: ${id}`, { field: "body.id" }),
      );
    }
    const apiFormat =
      raw.apiFormat === "anthropic-messages" || raw.apiFormat === "responses"
        ? (raw.apiFormat as string)
        : "chat-completions";

    // ── R89-B1: the owner's identity rules ─────────────────────────────────
    // Verbatim: "the user can add as many providers as needed… The only
    // thing you need to keep in mind is the provider name. Only the
    // provider name should be different. It should not be already
    // available." Two consequences:
    //
    //   1. NAME is the uniqueness key — a 409 with field body.name, not
    //      the old id-collision the owner hit ("provider NVIDIA already
    //      exists" on a FRESH reset — the boot seed re-creates the five
    //      keyless built-in rows, which the R58 list renders as absent).
    //   2. A keyless row at the wanted id is ADOPTED in place (configure
    //      the built-in) instead of 409ing — the row is invisible in the
    //      UI until it has a key, so adoption can never surprise anyone.
    // A CONFIGURED row at the wanted id (a second NVIDIA preset while the
    // first is live) derives a fresh id from the requested NAME — the
    // user keeps adding same-type providers under different names.
    const wantedName = raw.name.trim();
    const existingRow = getProviderRecord(db, id);
    const adoptable = existingRow !== undefined && !keyring.has(id);
    const nameCollision = adoptable
      ? (db.prepare("SELECT 1 FROM providers WHERE name = ? AND id != ?").get(wantedName, id) as
          | { 1: number }
          | undefined)
      : (db.prepare("SELECT 1 FROM providers WHERE name = ?").get(wantedName) as
          | { 1: number }
          | undefined);
    if (nameCollision !== undefined) {
      return reply.code(409).send(
        errorBody("CONFLICT", `provider name '${wantedName}' is already in use — pick a different display name`, {
          field: "body.name",
        }),
      );
    }
    if (adoptable && existingRow !== undefined) {
      // Adopt the invisible keyless row: same id (the key the dialog is
      // about to store lands on it), the request's name/baseUrl/apiFormat.
      const adopted = updateProviderRecord(db, {
        ...existingRow,
        name: wantedName,
        baseUrl: baseUrl.toString(),
        apiFormat,
      });
      // R92-D: keyCount rides the hand-built view too (a keyless PRIMARY can
      // still own POOL slots — the count is honest, not assumed zero).
      return reply.code(200).send({
        ...adopted,
        hasKey: false,
        keyCount: resolveKeyPool(keyring, adopted.id).length,
        adopted: true,
      });
    }
    if (providerRecordIdExists(db, id)) {
      // Configured row at the wanted id — derive a fresh one from the NAME
      // (the preset's second instance: "NVIDIA Work" → prv_nvidia-work).
      const derived = slugifyProviderId(wantedName);
      if (derived === "" || providerRecordIdExists(db, derived)) {
        // Either the name cannot slugify or even the derived id is taken —
        // walk the -2/-3 suffixes; give up honestly after 16 tries.
        const base = derived === "" ? "prv_provider" : derived;
        let candidate = "";
        for (let n = 2; n <= 17; n += 1) {
          const probe = `${base}-${n}`;
          if (!providerRecordIdExists(db, probe)) {
            candidate = probe;
            break;
          }
        }
        if (candidate === "") {
          return reply.code(409).send(
            errorBody("CONFLICT", "no free provider id — remove one of the same-name providers first", {
              field: "body.id",
            }),
          );
        }
        id = candidate;
      } else {
        id = derived;
      }
    }
    if (RESERVED_PROVIDER_IDS.includes(id)) {
      clearProviderTombstone(db, id);
    }
    const record = createProviderRecord(db, {
      id,
      name: wantedName,
      baseUrl: baseUrl.toString(),
      apiFormat,
    });
    // R92-D: keyCount (0 on a fresh id — the key lands after this response).
    return reply
      .code(201)
      .send({ ...record, hasKey: keyring.has(record.id), keyCount: resolveKeyPool(keyring, record.id).length });
  });

  // ROUND-37 (owner: "he will be given these options to delete it, to
  // change the base URL, to change the name… and the API key"): EVERY
  // provider is editable — built-ins included. The old 409 for built-ins
  // is gone; only the reserved-id IMMUTABILITY of seeding is protected
  // (via tombstones on delete).
  scope.patch("/providers/:id", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    const record = resolveProvider(db, id);
    if (record === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no provider with id ${id}`));
    }
    const body: unknown = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return reply
        .code(400)
        .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
    }
    const raw = body as Record<string, unknown>;
    let baseUrl = record.baseUrl;
    if (raw.baseUrl !== undefined) {
      if (typeof raw.baseUrl !== "string") {
        return reply.code(400).send(
          errorBody("VALIDATION", "baseUrl must be a http(s) URL string", { field: "body.baseUrl" }),
        );
      }
      try {
        const parsed = new URL(raw.baseUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("bad protocol");
        baseUrl = parsed.toString();
      } catch {
        return reply.code(400).send(
          errorBody("VALIDATION", "baseUrl must be a valid URL", { field: "body.baseUrl" }),
        );
      }
    }
    const name =
      typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name.trim() : record.name;
    // R89-B1: the name is the uniqueness key on PATCH too — renaming into
    // another provider's name 409s (field body.name), same rule as POST.
    if (name !== record.name) {
      const collision = db.prepare("SELECT 1 FROM providers WHERE name = ? AND id != ?").get(
        name,
        record.id,
      ) as { 1: number } | undefined;
      if (collision !== undefined) {
        return reply.code(409).send(
          errorBody("CONFLICT", `provider name '${name}' is already in use — pick a different display name`, {
            field: "body.name",
          }),
        );
      }
    }
    const apiFormat =
      raw.apiFormat === "anthropic-messages" || raw.apiFormat === "responses" || raw.apiFormat === "chat-completions"
        ? raw.apiFormat
        : record.apiFormat;
    const enabled = typeof raw.enabled === "boolean" ? raw.enabled : record.enabled;
    const updated = updateProviderRecord(db, { ...record, name, baseUrl, apiFormat, enabled });
    // R92-D: keyCount on the PATCH response too (the GET list's shape).
    return reply
      .code(200)
      .send({ ...updated, hasKey: keyring.has(updated.id), keyCount: resolveKeyPool(keyring, updated.id).length });
  });

  // ROUND-37: delete ANY provider (built-ins write a tombstone so the
  // boot seed doesn't resurrect them; re-adding via Add Provider clears
  // it). Agents referencing the provider still block deletion — their
  // next turn would 409 on a dead provider otherwise.
  //
  // R91-A (the owner's v0.88.0 report: "when I tried to delete an OpenRouter
  // provider, it apparently was not getting deleted" — the default agent
  // row references openrouter, so every delete 409'd while NVIDIA/custom
  // providers deleted fine): `?force=1` makes the delete SUCCEED by
  // reassigning every referencing agent to NO provider (providerId = NULL,
  // model cleared) — the composer's model picker then asks for a model on
  // the next send, exactly like a fresh agent. The confirm dialog in the
  // settings UI tells the owner exactly which agents will be reset BEFORE
  // the click; the unforced 409 stays as the API's honest default for any
  // other caller.
  scope.delete("/providers/:id", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    const query = request.query as Record<string, unknown>;
    const force = query.force === "1" || query.force === "true";
    const record = resolveProvider(db, id);
    if (record === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no provider with id ${id}`));
    }
    const referencing = listAgents(db, true).filter((a) => a.providerId === id);
    if (referencing.length > 0 && !force) {
      return reply.code(409).send(
        errorBody(
          "CONFLICT",
          `${referencing.length} agent${referencing.length === 1 ? "" : "s"} still use '${record.name}' (${referencing.map((a) => a.name).join(", ")}) — reassign or delete them first, or delete with ?force=1 to reset those agents to pick a new model`,
          { field: "params.id", agents: referencing.map((a) => a.id) },
        ),
      );
    }
    if (referencing.length > 0 && force) {
      // Reset each referencing agent to the "no provider picked" state —
      // providerId NULL + model NULL (R91-A's resetAgentsProvider; the
      // composer's model picker then asks for a model on the next send,
      // exactly like a fresh agent). One statement, all-or-nothing.
      resetAgentsProvider(db, id);
    }
    deleteProviderRecord(db, id);
    keyring.set(id, "");
    // 204 both ways (the pre-R91 contract, test-pinned): the caller already
    // knows the referencing agents' names from the confirm dialog, so the
    // reassigned count carries no new information across the wire.
    return reply.code(204).send();
  });

  scope.get("/providers/:id/models", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    if (resolveProvider(db, id) === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no provider with id ${id}`));
    }
    try {
      const result = await fetchProviderModels(db, keyring, id);
      if (result === undefined) {
        return reply.code(404).send(errorBody("NOT_FOUND", `no provider with id ${id}`));
      }
      return result;
    } catch (error) {
      // ProviderFetchError carries sanitized upstream context; anything
      // else still maps to the same envelope without internals.
      const message =
        error instanceof Error ? error.message : `provider '${id}' models fetch failed`;
      return reply
        .code(502)
        .send(errorBody("PROVIDER_ERROR", message, { providerId: id }));
    }
  });

  // Wizard connection-test pill (API.md §8.6, cheap variant): proves the
  // provider exists, the keyring holds a key, and the key is accepted
  // upstream — without spending tokens on a completion.
  // ROUND-47 (R47-b): {model?, slot?} — slot scopes the probe to one
  // key-pool entry (slot 0 = primary; omitted = primary, exactly the
  // pre-R47 behavior) so each pool key is testable in place.
  scope.post("/providers/:id/test", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    const provider = resolveProvider(db, id);
    if (provider === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no provider with id ${id}`));
    }
    let model: string | undefined;
    let slot: number | undefined;
    const body: unknown = request.body;
    if (body !== undefined && body !== null) {
      if (typeof body !== "object" || Array.isArray(body)) {
        return reply
          .code(400)
          .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
      }
      const raw = body as Record<string, unknown>;
      const rawModel = raw.model;
      if (rawModel !== undefined) {
        if (typeof rawModel !== "string" || rawModel.trim() === "") {
          return reply.code(400).send(
            errorBody("VALIDATION", "model must be a non-empty string", {
              field: "body.model",
            }),
          );
        }
        model = rawModel;
      }
      // ROUND-47 (R47-b): {slot} scopes the probe to ONE key-pool entry
      // (slot 0 = the primary) so the Key Pool UI can test each key in
      // place. The plan contract: integer 0..31, 409 when that slot
      // holds no key.
      const rawSlot = raw.slot;
      if (rawSlot !== undefined) {
        if (
          typeof rawSlot !== "number" ||
          !Number.isInteger(rawSlot) ||
          rawSlot < 0 ||
          rawSlot > 31
        ) {
          return reply.code(400).send(
            errorBody("VALIDATION", "slot must be an integer between 0 and 31", {
              field: "body.slot",
            }),
          );
        }
        slot = rawSlot;
      }
    }
    // Key resolution: slot omitted → the primary (exactly the pre-R47
    // behavior, same 409 wording). Slot given → that POOL slot's key
    // (slot 0 IS the primary slot), 409 naming provider + slot when empty.
    let keyOverride: string | undefined;
    if (slot === undefined) {
      if (!keyring.has(id)) {
        return reply.code(409).send(
          errorBody(
            "CONFLICT",
            `no API key stored for provider '${id}' — save one in Windows Credential Manager before testing`,
            { providerId: id },
          ),
        );
      }
    } else {
      keyOverride = keyring.getSlot(id, slot);
      if (keyOverride === undefined) {
        return reply.code(409).send(
          errorBody(
            "CONFLICT",
            `no API key stored for provider '${id}' slot ${slot} — save one in Settings → Models & Providers`,
            { providerId: id, slot },
          ),
        );
      }
    }
    try {
      return await testProviderConnection(keyring, provider, model, keyOverride);
    } catch (error) {
      // The probe executed and the provider answered NO (bad key, unknown
      // model): HTTP 200 with ok:false — the test call itself succeeded.
      if (error instanceof ProviderTestError) {
        return { ok: false, message: error.message };
      }
      const message =
        error instanceof Error ? error.message : `provider '${id}' connection test failed`;
      return reply
        .code(502)
        .send(errorBody("PROVIDER_ERROR", message, { providerId: id }));
    }
  });

  // ---- Models (round-19: per-provider model metadata + pricing) ----

  scope.get("/providers/:id/models-config", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    if (resolveProvider(db, id) === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no provider with id ${id}`));
    }
    return { models: listModels(db, id) };
  });

  scope.post("/providers/:id/models", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    if (resolveProvider(db, id) === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no provider with id ${id}`));
    }
    const body: unknown = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return reply
        .code(400)
        .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
    }
    const raw = body as Record<string, unknown>;
    if (typeof raw.modelId !== "string" || raw.modelId.trim() === "") {
      return reply.code(400).send(
        errorBody("VALIDATION", "modelId must be a non-empty string", { field: "body.modelId" }),
      );
    }
    // ROUND-50 (R50-d): strict field validation — a malformed value is a
    // 400 naming the field, never a silently dropped "successful" save.
    const numerics = readModelNumericFields(raw);
    if (!numerics.ok) {
      return reply.code(400).send(
        errorBody("VALIDATION", `${numerics.field} must be a number or null`, {
          field: `body.${numerics.field}`,
        }),
      );
    }
    const scalars = readModelScalarFields(raw);
    if (!scalars.ok) {
      // ROUND-82 + ROUND-87: the tri-state capability fields accept boolean
      // OR null (null = reset to unknown); the legacy fields stay
      // boolean-only, the string fields string-or-null.
      const triState = isModelTriStateField(scalars.field);
      return reply.code(400).send(
        errorBody(
          "VALIDATION",
          `${scalars.field} must be ${
            triState
              ? "a boolean or null (unknown)"
              : scalars.field === "displayName" || scalars.field === "sizeLabel"
                ? "a string"
                : "a boolean"
          }`,
          { field: `body.${scalars.field}` },
        ),
      );
    }
    const model = upsertModel(db, id, {
      modelId: raw.modelId.trim(),
      displayName: typeof raw.displayName === "string" ? raw.displayName : undefined,
      ...numerics.values,
      // Absent toggles stay undefined so upsertModel KEEPS the stored
      // value (the old `=== true` coercion reset them to false on every
      // re-upsert of an existing model — the "add model" flow no longer
      // wipes supportsThinking/hidden).
      supportsThinking: typeof raw.supportsThinking === "boolean" ? raw.supportsThinking : undefined,
      supportsVision: typeof raw.supportsVision === "boolean" ? raw.supportsVision : undefined,
      // ROUND-82 (R82): the tri-state capability flags — boolean sets,
      // null clears to unknown, absent keeps (the R50-d contract).
      supportsTools: readTriStateField(raw.supportsTools),
      supportsAudio: readTriStateField(raw.supportsAudio),
      supportsVideo: readTriStateField(raw.supportsVideo),
      // ROUND-87 (R87): the input/output capability columns + size label —
      // same tri-state contract (boolean sets, null clears to unknown,
      // absent keeps); sizeLabel is string-or-null.
      supportsPdf: readTriStateField(raw.supportsPdf),
      supportsTextOutput: readTriStateField(raw.supportsTextOutput),
      supportsImageOutput: readTriStateField(raw.supportsImageOutput),
      supportsVideoOutput: readTriStateField(raw.supportsVideoOutput),
      supportsAudioOutput: readTriStateField(raw.supportsAudioOutput),
      sizeLabel:
        raw.sizeLabel === undefined
          ? undefined
          : raw.sizeLabel === null || typeof raw.sizeLabel === "string"
            ? raw.sizeLabel
            : undefined,
      hidden: typeof raw.hidden === "boolean" ? raw.hidden : undefined,
    });
    return reply.code(201).send(model);
  });
  // ROUND-47 (R47-b): the old GET /providers/:id/key (round-19 "view/copy")
  // was REMOVED — it returned the RAW key value, contradicting the
  // "keys never appear in any response" invariant at the top of this
  // route group, and nothing ever called it (src/, src-tauri/, onboarding/
  // only PUT). Only the update route below survives.
  scope.put("/providers/:id/key", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    if (resolveProvider(db, id) === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no provider with id ${id}`));
    }
    const body: unknown = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return reply
        .code(400)
        .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
    }
    const value = (body as Record<string, unknown>).value;
    if (typeof value !== "string" || value.trim() === "") {
      return reply.code(400).send(
        errorBody("VALIDATION", "value must be a non-empty string", { field: "body.value" }),
      );
    }
    keyring.set(id, value.trim());
    return reply.code(204).send();
  });
  // ── ROUND-36: API key pool (per provider) ──────────────────────────

  scope.get("/providers/:id/keys", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    if (resolveProvider(db, id) === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no provider with id ${id}`));
    }
    return { keys: keyring.poolInfo(id) };
  });

  // ROUND-58 (R58-d): POST /providers/:id/keys/reveal — the ONE route
  // that returns key VALUES. The owner explicitly asked for visible keys
  // ("Make sure that the API key shows properly there too in our
  // application. It should not be hidden. I should be able to click the
  // options there and I should be able to see the API key there, every
  // single one of the API keys, without any issues.") — this consciously
  // reverses the R47 "keys never appear in any response" invariant FOR
  // THIS SINGLE ROUTE ONLY: every other /keys response stays masked
  // (poolInfo), and the key values are still NEVER logged anywhere.
  // Same bearer wall + 404 semantics as the sibling pool routes.
  scope.post("/providers/:id/keys/reveal", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    if (resolveProvider(db, id) === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no provider with id ${id}`));
    }
    // Every HELD slot with its full value (slot 0 = the primary, plus the
    // pool slots the keyring holds). getPool never logs, only reads.
    return { keys: keyring.getPool(id).map(({ slot, key }) => ({ slot, value: key })) };
  });

  scope.put("/providers/:id/keys/:slot", async (request, reply) => {
    const { id, slot } = request.params as Record<string, string>;
    if (resolveProvider(db, id) === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no provider with id ${id}`));
    }
    const slotNum = Number(slot);
    if (!Number.isInteger(slotNum) || slotNum < 0 || slotNum > 31) {
      return reply.code(400).send(errorBody("VALIDATION", `invalid slot ${slot}`, { field: "params.slot" }));
    }
    const body: unknown = request.body;
    if (typeof body !== "object" || body === null) {
      return reply.code(400).send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
    }
    const value = (body as Record<string, unknown>).value;
    if (typeof value !== "string" || value.trim() === "") {
      return reply.code(400).send(
        errorBody("VALIDATION", "value must be a non-empty string", { field: "body.value" }),
      );
    }
    keyring.setSlot(id, slotNum, value.trim());
    return reply.code(200).send({ keys: keyring.poolInfo(id) });
  });

  scope.delete("/providers/:id/keys/:slot", async (request, reply) => {
    const { id, slot } = request.params as Record<string, string>;
    if (resolveProvider(db, id) === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no provider with id ${id}`));
    }
    const slotNum = Number(slot);
    if (!Number.isInteger(slotNum) || slotNum < 0 || slotNum > 31) {
      return reply.code(400).send(errorBody("VALIDATION", `invalid slot ${slot}`, { field: "params.slot" }));
    }
    if (slotNum === 0) {
      return reply.code(409).send(
        errorBody("CONFLICT", "the primary key is removed via the main key endpoint", {
          field: "params.slot",
        }),
      );
    }
    keyring.setSlot(id, slotNum, "");
    // The removed slot itself may drop out of poolInfo (env state has no
    // high-water mark) — re-include it as empty so the UI keeps the row.
    const keys = keyring.poolInfo(id).filter((k) => k.slot !== slotNum);
    keys.push({ slot: slotNum, hasKey: false, masked: null });
    keys.sort((a, b) => a.slot - b.slot);
    return reply.code(200).send({ keys });
  });
}
