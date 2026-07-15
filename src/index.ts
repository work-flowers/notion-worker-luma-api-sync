import { Worker } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";

const worker = new Worker();
export default worker;

const LUMA_API_BASE = "https://public-api.luma.com";
const PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Luma API types (list guests endpoint)
// ---------------------------------------------------------------------------

type RegistrationAnswerValue =
	| string
	| boolean
	| string[]
	| { company?: string | null; job_title?: string | null }
	| null
	| undefined;

interface RegistrationAnswer {
	label: string;
	question_id: string;
	question_type: string;
	value?: RegistrationAnswerValue;
}

interface EventTicket {
	id: string;
	checked_in_at: string | null;
	event_ticket_type_id: string;
	is_captured: boolean;
	name: string;
	// Monetary fields (amount, amount_discount, amount_tax, currency) are
	// intentionally ignored — events are free.
}

interface LumaGuest {
	id: string;
	user_id: string;
	user_email: string;
	user_name: string | null;
	user_first_name: string | null;
	user_last_name: string | null;
	approval_status:
		| "approved"
		| "session"
		| "pending_approval"
		| "invited"
		| "declined"
		| "waitlist";
	check_in_qr_code: string;
	eth_address: string | null;
	invited_at: string | null;
	joined_at: string | null;
	phone_number: string | null;
	registered_at: string | null;
	registration_answers: RegistrationAnswer[] | null;
	solana_address: string | null;
	utm_source: string | null;
	event_tickets: EventTicket[];
}

interface ListGuestsResponse {
	entries: LumaGuest[];
	has_more: boolean;
	next_cursor?: string;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const guests = worker.database("lumaGuests", {
	type: "managed",
	initialTitle: "Luma Guests",
	primaryKeyProperty: "Guest ID",
	schema: {
		properties: {
			Name: Schema.title(),
			"Guest ID": Schema.richText(),
			"User ID": Schema.richText(),
			Email: Schema.email(),
			"First Name": Schema.richText(),
			"Last Name": Schema.richText(),
			"Approval Status": Schema.select([
				{ name: "approved", color: "green" },
				{ name: "session", color: "blue" },
				{ name: "pending_approval", color: "yellow" },
				{ name: "invited", color: "purple" },
				{ name: "declined", color: "red" },
				{ name: "waitlist", color: "orange" },
			]),
			"Phone Number": Schema.phoneNumber(),
			"Registered At": Schema.date(),
			"Invited At": Schema.date(),
			"Joined At": Schema.date(),
			"Check-in QR Code": Schema.richText(),
			"ETH Address": Schema.richText(),
			"Solana Address": Schema.richText(),
			"UTM Source": Schema.richText(),
			"Registration Answers": Schema.richText(),
			// event_tickets, flattened (monetary fields ignored — events are free)
			"Ticket Names": Schema.richText(),
			"Ticket Count": Schema.number(),
			"Ticket IDs": Schema.richText(),
			"Ticket Type IDs": Schema.richText(),
			"Checked In": Schema.checkbox(),
			"Checked In At": Schema.date(),
			"Tickets Captured": Schema.checkbox(),
		},
	},
});

// ---------------------------------------------------------------------------
// Pacer — Luma allows 200 req/min per calendar API key; use half the budget.
// ---------------------------------------------------------------------------

const lumaApi = worker.pacer("lumaApi", {
	allowedRequests: 100,
	intervalMs: 60_000,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_RICH_TEXT = 1_900;

function truncate(text: string): string {
	return text.length > MAX_RICH_TEXT ? `${text.slice(0, MAX_RICH_TEXT)}…` : text;
}

function formatAnswerValue(value: RegistrationAnswerValue): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "boolean") return value ? "Yes" : "No";
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.join(", ");
	// company question: { company, job_title }
	return [value.company, value.job_title].filter(Boolean).join(" — ");
}

function formatRegistrationAnswers(answers: RegistrationAnswer[] | null): string {
	if (!answers || answers.length === 0) return "";
	return truncate(
		answers
			.map((a) => `${a.label}: ${formatAnswerValue(a.value)}`)
			.join("\n"),
	);
}

async function fetchGuestsPage(cursor: string | undefined): Promise<ListGuestsResponse> {
	const apiKey = process.env.LUMA_API_KEY;
	const eventId = process.env.LUMA_EVENT_ID;
	if (!apiKey) throw new Error("LUMA_API_KEY environment variable is not set");
	if (!eventId) throw new Error("LUMA_EVENT_ID environment variable is not set");

	const url = new URL("/v1/events/guests/list", LUMA_API_BASE);
	url.searchParams.set("event_id", eventId);
	url.searchParams.set("pagination_limit", String(PAGE_SIZE));
	if (cursor) url.searchParams.set("pagination_cursor", cursor);

	await lumaApi.wait();
	const response = await fetch(url, {
		headers: { "x-luma-api-key": apiKey, accept: "application/json" },
	});
	if (!response.ok) {
		const body = await response.text();
		throw new Error(`Luma API error ${response.status}: ${body.slice(0, 500)}`);
	}
	return (await response.json()) as ListGuestsResponse;
}

function guestToChange(guest: LumaGuest) {
	const tickets = guest.event_tickets ?? [];
	const checkedInAt =
		tickets
			.map((t) => t.checked_in_at)
			.filter((t): t is string => Boolean(t))
			.sort()[0] ?? null;

	return {
		type: "upsert" as const,
		key: guest.id,
		properties: {
			Name: Builder.title(guest.user_name ?? guest.user_email),
			"Guest ID": Builder.richText(guest.id),
			"User ID": Builder.richText(guest.user_id),
			Email: Builder.email(guest.user_email),
			"First Name": Builder.richText(guest.user_first_name ?? ""),
			"Last Name": Builder.richText(guest.user_last_name ?? ""),
			"Approval Status": Builder.select(guest.approval_status),
			"Phone Number": Builder.phoneNumber(guest.phone_number ?? ""),
			...(guest.registered_at
				? { "Registered At": Builder.dateTime(guest.registered_at) }
				: {}),
			...(guest.invited_at ? { "Invited At": Builder.dateTime(guest.invited_at) } : {}),
			...(guest.joined_at ? { "Joined At": Builder.dateTime(guest.joined_at) } : {}),
			"Check-in QR Code": Builder.richText(guest.check_in_qr_code ?? ""),
			"ETH Address": Builder.richText(guest.eth_address ?? ""),
			"Solana Address": Builder.richText(guest.solana_address ?? ""),
			"UTM Source": Builder.richText(guest.utm_source ?? ""),
			"Registration Answers": Builder.richText(
				formatRegistrationAnswers(guest.registration_answers),
			),
			"Ticket Names": Builder.richText(truncate(tickets.map((t) => t.name).join(", "))),
			"Ticket Count": Builder.number(tickets.length),
			"Ticket IDs": Builder.richText(truncate(tickets.map((t) => t.id).join(", "))),
			"Ticket Type IDs": Builder.richText(
				truncate(tickets.map((t) => t.event_ticket_type_id).join(", ")),
			),
			"Checked In": Builder.checkbox(checkedInAt !== null),
			...(checkedInAt ? { "Checked In At": Builder.dateTime(checkedInAt) } : {}),
			"Tickets Captured": Builder.checkbox(
				tickets.length > 0 && tickets.every((t) => t.is_captured),
			),
		},
	};
}

// ---------------------------------------------------------------------------
// Sync — simple replace: the list-guests endpoint has no change tracking, and
// a single event's guest list is small. Replace mode also removes guests no
// longer returned by Luma.
// ---------------------------------------------------------------------------

worker.sync("lumaGuestsSync", {
	database: guests,
	mode: "replace",
	schedule: "15m",
	execute: async (state: { cursor?: string } | undefined) => {
		const page = await fetchGuestsPage(state?.cursor);
		return {
			changes: page.entries.map(guestToChange),
			hasMore: page.has_more,
			nextState: page.has_more ? { cursor: page.next_cursor } : undefined,
		};
	},
});
