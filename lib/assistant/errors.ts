/**
 * Every stable code the assistant reports, from the API (a refused send) or on
 * a failed message (lib/assistant/run-turn.ts), mapped to its wording key in
 * the `assistantErrors` namespace of messages/*.json. The server words its
 * refusals with it and the chat words a failed message's `errorCode` with it.
 */
export const ASSISTANT_ERROR_MESSAGE_KEYS = {
  "assistant.not_configured": "notConfigured",
  "assistant.daily_cap_reached": "dailyCapReached",
  "assistant.busy": "busy",
  "assistant.unavailable": "unavailable",
  "assistant.credit_exhausted": "creditExhausted",
  "assistant.refused": "refused",
  "assistant.too_many_steps": "tooManySteps",
  "assistant.interrupted": "interrupted",
  "assistant.failed": "failed",
  "assistant.model_no_tools": "modelNoTools",
  "assistant.model_no_drafts": "modelNoDrafts",
  "assistant.environment_gone": "environmentGone",
  "assistant.context_gone": "contextGone",
  "assistant.nothing_to_draft": "nothingToDraft",
  "assistant.invalid_draft": "invalidDraft",
  "assistant.jira_push_disabled": "jiraPushDisabled",
  "assistant.draft_already_created": "draftAlreadyCreated",
  "assistant.jira_create_failed": "jiraCreateFailed",
} as const;

export type AssistantErrorCodeKey = keyof typeof ASSISTANT_ERROR_MESSAGE_KEYS;
