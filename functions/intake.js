/**
 * Cloudflare Pages Function — POST /intake
 *
 * Receives a JSON submission from the ADG landing page and creates:
 *   1. a HubSpot contact (upsert by email)
 *   2. an intake Deal in the "Client Intake" pipeline, first stage
 *   3. a contact<->deal association
 *   4. a note with the visitor's message
 * ...auto-assigning the deal to the right attorney by practice area.
 *
 * This is the JS twin of scripts/intake_handler.py from the CRM setup package.
 *
 * SETUP (Cloudflare dashboard → your Pages project → Settings → Variables):
 *   HUBSPOT_ACCESS_TOKEN   (required)  your HubSpot private-app token
 *   ALLOWED_ORIGIN         (optional)  e.g. https://intake.alfreddalegroup.com
 *                                      restricts who can POST here. Defaults to "*".
 *
 * No secrets live in this file — the token is read from the environment.
 */

const HS = "https://api.hubapi.com";
const PIPELINE_LABEL = "Client Intake";

// Practice area -> attorney owner email (@alfreddalegroup.com).
// Keep in sync with config/automations.py. Edit to your real attorneys.
const ATTORNEY_BY_AREA = {
  "Corporate / Business": "corporate@alfreddalegroup.com",
  "Litigation": "litigation@alfreddalegroup.com",
  "Real Estate": "realestate@alfreddalegroup.com",
  "Estate Planning / Probate": "estates@alfreddalegroup.com",
  "Family Law": "family@alfreddalegroup.com",
};
const ATTORNEY_DEFAULT = "intake@alfreddalegroup.com";

// ---- CORS helpers ----------------------------------------------------------
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
}

export async function onRequestOptions(context) {
  const origin = context.env.ALLOWED_ORIGIN || "*";
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const origin = env.ALLOWED_ORIGIN || "*";
  const headers = corsHeaders(origin);

  const token = env.HUBSPOT_ACCESS_TOKEN;
  if (!token) {
    return json({ ok: false, error: "Server not configured (missing token)." }, 500, headers);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON." }, 400, headers);
  }

  // Honeypot: silently accept and drop bots.
  if (body.company_website) {
    return json({ ok: true, dropped: true }, 200, headers);
  }

  const email = (body.email || "").trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ ok: false, error: "A valid email is required." }, 400, headers);
  }

  const hs = hsClient(token);

  try {
    // 1. Upsert contact ----------------------------------------------------
    const contactProps = {
      email,
      firstname: body.first_name || "",
      lastname: body.last_name || "",
      phone: body.phone || "",
      adg_lead_source: body.lead_source || "Website",
      adg_contact_role: "Prospective Client",
      hs_lead_status: "New",
    };
    if (body.practice_area) contactProps.adg_practice_area = body.practice_area;
    if (body.preferred_contact_method) {
      contactProps.adg_preferred_contact_method = body.preferred_contact_method;
    }

    let contactId = await upsertContact(hs, email, contactProps);

    // 2. Find pipeline + first stage --------------------------------------
    const pipelines = await hs("GET", "/crm/v3/pipelines/deals");
    const pipeline = (pipelines.results || []).find((p) => p.label === PIPELINE_LABEL);
    if (!pipeline) {
      return json(
        { ok: false, error: `Pipeline "${PIPELINE_LABEL}" not found. Run setup_crm.py first.` },
        500, headers
      );
    }
    const stages = [...pipeline.stages].sort(
      (a, b) => (a.displayOrder || 0) - (b.displayOrder || 0)
    );
    const stageId = stages[0].id;

    // 3. Resolve attorney owner -------------------------------------------
    const ownerEmail = ATTORNEY_BY_AREA[body.practice_area] || ATTORNEY_DEFAULT;
    const ownerId = await findOwnerId(hs, ownerEmail);

    // 4. Create the deal ---------------------------------------------------
    const name = `${(body.first_name || "").trim()} ${(body.last_name || "").trim()}`.trim();
    const dealProps = {
      dealname: `${name || "New Lead"} — ${body.practice_area || "Intake"}`,
      pipeline: pipeline.id,
      dealstage: stageId,
    };
    if (body.practice_area) dealProps.adg_matter_type = body.practice_area;
    if (ownerId) dealProps.hubspot_owner_id = ownerId;

    const deal = await hs("POST", "/crm/v3/objects/deals", { properties: dealProps });
    const dealId = deal.id;

    // 5. Associate contact <-> deal (default type id 3) --------------------
    await hs("PUT",
      `/crm/v3/objects/deals/${dealId}/associations/contacts/${contactId}/3`, null);

    // 6. Note with the message --------------------------------------------
    if (body.message) {
      await hs("POST", "/crm/v3/objects/notes", {
        properties: { hs_note_body: escapeHtml(body.message), hs_timestamp: Date.now() },
        associations: [{
          to: { id: contactId },
          types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }],
        }],
      });
    }

    return json({ ok: true, contactId, dealId }, 200, headers);
  } catch (err) {
    // Don't leak internals to the browser; log for the Cloudflare dashboard.
    console.error("intake error:", err && err.message);
    return json({ ok: false, error: "Submission failed. Please try again." }, 502, headers);
  }
}

// ---- HubSpot client --------------------------------------------------------
function hsClient(token) {
  return async function (method, path, payload) {
    const res = await fetch(HS + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: payload === null || payload === undefined ? undefined : JSON.stringify(payload),
    });
    if (res.status === 429) {
      // simple one-shot backoff
      await new Promise((r) => setTimeout(r, 1200));
      return hsClient(token)(method, path, payload);
    }
    const text = await res.text();
    if (!res.ok) {
      const e = new Error(`${method} ${path} -> ${res.status}: ${text}`);
      e.status = res.status;
      throw e;
    }
    return text ? JSON.parse(text) : {};
  };
}

async function upsertContact(hs, email, props) {
  try {
    const c = await hs("POST", "/crm/v3/objects/contacts", { properties: props });
    return c.id;
  } catch (err) {
    if (err.status === 409) {
      // Already exists — search by email, then patch.
      const found = await hs("POST", "/crm/v3/objects/contacts/search", {
        filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
      });
      const id = found.results && found.results[0] && found.results[0].id;
      if (!id) throw err;
      await hs("PATCH", `/crm/v3/objects/contacts/${id}`, { properties: props });
      return id;
    }
    throw err;
  }
}

async function findOwnerId(hs, email) {
  try {
    const res = await hs("GET", `/crm/v3/owners?email=${encodeURIComponent(email)}`);
    const o = res.results && res.results[0];
    return o ? o.id : null;
  } catch {
    return null; // assignment is best-effort; never block the lead
  }
}

// ---- utils -----------------------------------------------------------------
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
