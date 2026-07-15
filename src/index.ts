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
// Registration questions for this event, discovered from the guest list.
// Each question becomes its own database property (property name = question
// label). If the event's questions change, update this list and redeploy —
// answers to unknown questions are skipped.
// ---------------------------------------------------------------------------

interface QuestionConfig {
	/** Luma question label, matched against registration_answers[].label */
	label: string;
	/** Trimmed Notion property name */
	property: string;
	kind: "text" | "email" | "select" | "checkbox";
	/** For selects: known option names (new answer values auto-create options) */
	options?: string[];
	/** For selects: normalize raw answer values into comma-free option names */
	transform?: (value: string) => string;
}

const QUESTIONS: QuestionConfig[] = [
	{
		label: "Are you a Lorong AI Member?",
		property: "Lorong AI Member",
		kind: "select",
		options: ["Yes", "No"],
		// "No, not a Lorong AI Member" → "No"
		transform: (v) => v.split(",")[0].trim(),
	},
	{
		label: "Which sector are you from?",
		property: "Sector",
		kind: "select",
		options: ["Industry", "Others"],
	},
	{
		label: "What company/organisation do you work for?",
		property: "Company / Organisation",
		kind: "text",
	},
	{
		label: "Job Title (This helps us better understand our audience and plan content that’s most relevant to your team)",
		property: "Job Title",
		kind: "text",
	},
	{
		label: "What is your LinkedIn profile?",
		property: "LinkedIn",
		kind: "text",
	},
	{
		label: "How comfortable are you with technical AI concepts?",
		property: "AI Comfort Level",
		kind: "select",
		options: ["Level 100 - Beginner", "Level 200 - Intermediate", "Level 300 - Advanced"],
		// "Level 200 - Intermediate: Some technical knowledge. …" → "Level 200 - Intermediate"
		transform: (v) => v.split(":")[0].trim(),
	},
	{
		label: "Which best describes how you use Notion today?",
		property: "Notion Usage",
		kind: "select",
		options: [
			"Personal use only",
			"Exploring / just getting started",
			"Startup (founder or early team)",
			"Growing team / scale-up",
			"Enterprise / large organisation",
		],
	},
	{
		label: "What Notion Plan are you on?",
		property: "Notion Plan",
		kind: "select",
		options: ["Free", "Plus", "Business", "Enterprise"],
	},
	{
		label: "How many employees are in your organisation?",
		property: "Organisation Size",
		kind: "select",
		options: ["1-10"],
	},
	{
		label: "Tell us what do you expect to learn in this session?",
		property: "Learning Expectations",
		kind: "text",
	},
	{
		label: "Have a question for the speaker? Submit it below",
		property: "Question for Speaker",
		kind: "text",
	},
	{
		label: "We’re offering an exclusive 3-month trial of Notion Business + Notion AI for organisations with fewer than 100 employees (valued at over $6,000).  To access this offer, please enter your work email below (the domain you’d like us to provision for the trial).",
		property: "Trial Work Email",
		kind: "email",
	},
	{
		label: "Terms and Conditions",
		property: "Terms and Conditions",
		kind: "text",
	},
	{
		label: "What company do you work for?",
		property: "Company",
		kind: "text",
	},
	{
		label: "Have you used Zapier before?",
		property: "Zapier Experience",
		kind: "select",
		options: ["New to Zapier", "Not yet but I'd love to try", "Advanced Zapier user"],
	},
	{
		label: "Work email address (if different from your Luma user email address)",
		property: "Work Email",
		kind: "email",
	},
	{
		label: "Stay connected: Add me to the work.flowers mailing list for ops and automation insights, plus news on upcoming events.",
		property: "Mailing List Opt-in",
		kind: "checkbox",
	},
];

const QUESTIONS_BY_LABEL = new Map(QUESTIONS.map((q) => [q.label, q]));

function questionSchema(q: QuestionConfig) {
	switch (q.kind) {
		case "checkbox":
			return Schema.checkbox();
		case "email":
			return Schema.email();
		case "select":
			return Schema.select((q.options ?? []).map((name) => ({ name })));
		default:
			return Schema.richText();
	}
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
			"UTM Source": Schema.richText(),
			// registration_answers, one property per question
			...Object.fromEntries(QUESTIONS.map((q) => [q.property, questionSchema(q)])),
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

function answerProperties(answers: RegistrationAnswer[] | null) {
	const props: Record<string, ReturnType<typeof Builder.richText>> = {};
	for (const answer of answers ?? []) {
		const q = QUESTIONS_BY_LABEL.get(answer.label);
		// Unknown questions (added after this schema was generated) are skipped.
		if (!q) continue;
		switch (q.kind) {
			case "checkbox":
				props[q.property] = Builder.checkbox(answer.value === true);
				break;
			case "email":
				props[q.property] = Builder.email(formatAnswerValue(answer.value));
				break;
			case "select": {
				const raw = formatAnswerValue(answer.value);
				if (!raw) break;
				const name = (q.transform ? q.transform(raw) : raw).replace(/,/g, "");
				props[q.property] = Builder.select(name);
				break;
			}
			default:
				props[q.property] = Builder.richText(truncate(formatAnswerValue(answer.value)));
		}
	}
	return props;
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
			"UTM Source": Builder.richText(guest.utm_source ?? ""),
			...answerProperties(guest.registration_answers),
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
