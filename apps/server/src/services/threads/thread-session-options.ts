import { desc, sql, type SQL } from "drizzle-orm";
import { events, listLatestThreadStateEventRowsByThreadIds } from "@bb/db";
import type {
  AppendStoredThreadEventArgs,
  DbConnection,
  DbQueryConnection,
} from "@bb/db";
import {
  THREAD_SESSION_OPTIONS_STATE_KIND,
  THREAD_SESSION_OPTION_SELECTIONS_STATE_KIND,
  applySessionOptionSelectionPatch,
  retainedSessionOptionSelections,
  threadScope,
  threadSessionOptionSelectionsStateSchema,
  threadSessionOptionsStateSchema,
  type SessionOptionSelectionPatch,
  type SessionOptionSelections,
  type Thread,
  type ThreadSessionOption,
  type ThreadSessionOptionSelectionsState,
  type ThreadSessionOptionsState,
} from "@bb/domain";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import { decodeStoredEventRowCached } from "./stored-event-decode-cache.js";
import { parseStoredEvent } from "./thread-data.js";
import { appendThreadEvent } from "./thread-events.js";

interface ThreadStateSnapshot {
  payload: unknown;
  providerThreadId: string;
}

interface ThreadSessionOptionState {
  options: ThreadSessionOption[];
  optionsReported: boolean;
  providerThreadId: string | null;
  selections: SessionOptionSelections;
}

function readLatestThreadState(
  db: DbConnection,
  threadId: string,
  kind:
    | typeof THREAD_SESSION_OPTIONS_STATE_KIND
    | typeof THREAD_SESSION_OPTION_SELECTIONS_STATE_KIND,
): ThreadStateSnapshot | null {
  for (const row of listLatestThreadStateEventRowsByThreadIds(db, {
    threadIds: [threadId],
    kind,
  })) {
    const event = decodeStoredEventRowCached(db, row);
    if (event.type === "thread/extensionState/updated" && event.kind === kind) {
      return {
        payload: event.payload,
        providerThreadId: event.providerThreadId,
      };
    }
  }
  return null;
}

function readThreadSessionOptionState(
  db: DbConnection,
  threadId: string,
): ThreadSessionOptionState {
  const optionsSnapshot = readLatestThreadState(
    db,
    threadId,
    THREAD_SESSION_OPTIONS_STATE_KIND,
  );
  return {
    options: snapshotSessionOptions(optionsSnapshot),
    optionsReported: optionsSnapshot !== null,
    providerThreadId: optionsSnapshot?.providerThreadId ?? null,
    selections: snapshotSessionOptionSelections(
      readLatestThreadState(
        db,
        threadId,
        THREAD_SESSION_OPTION_SELECTIONS_STATE_KIND,
      ),
    ),
  };
}

function threadStatesBefore(
  threadId: string,
  kind: string,
  beforeSequence: number,
): SQL {
  return sql`${events.threadId} = ${threadId}
    AND ${events.type} = 'thread/extensionState/updated'
    AND ${events.sequence} < ${beforeSequence}
    AND json_extract(${events.data}, '$.kind') = ${kind}`;
}

function readThreadStateBefore(
  db: DbQueryConnection,
  threadId: string,
  kind: string,
  beforeSequence: number,
): ThreadStateSnapshot | null {
  const row = db
    .select()
    .from(events)
    .where(threadStatesBefore(threadId, kind, beforeSequence))
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();
  const event = row === undefined ? null : parseStoredEvent(row);
  return event?.type === "thread/extensionState/updated"
    ? { payload: event.payload, providerThreadId: event.providerThreadId }
    : null;
}

function listStickyOptionIdsBefore(
  db: DbQueryConnection,
  threadId: string,
  beforeSequence: number,
): { id: string; firstSequence: number }[] {
  return db.all(sql`SELECT id, MIN(sequence) AS firstSequence FROM (
      SELECT ${events.sequence} AS sequence,
        json_extract(session_option.value, '$.id') AS id
      FROM ${events}, json_each(${events.data}, '$.payload.options') AS session_option
      WHERE ${threadStatesBefore(threadId, THREAD_SESSION_OPTIONS_STATE_KIND, beforeSequence)}
        AND json_type(session_option.value, '$.experimental_sticky') = 'true'
      UNION ALL
      SELECT ${events.sequence}, sticky_option_id.value
      FROM ${events}, json_each(${events.data}, '$.payload.stickyOptionIds') AS sticky_option_id
      WHERE ${threadStatesBefore(threadId, THREAD_SESSION_OPTION_SELECTIONS_STATE_KIND, beforeSequence)}
    ) AS sticky_evidence
    GROUP BY id`);
}

function snapshotSessionOptions(
  snapshot: ThreadStateSnapshot | null,
): ThreadSessionOption[] {
  const parsed = threadSessionOptionsStateSchema.safeParse(snapshot?.payload);
  return parsed.success ? parsed.data.options : [];
}

function snapshotSessionOptionSelections(
  snapshot: ThreadStateSnapshot | null,
): SessionOptionSelections {
  const parsed = threadSessionOptionSelectionsStateSchema.safeParse(
    snapshot?.payload,
  );
  return parsed.success ? parsed.data.selections : {};
}

function sameSelections(
  left: SessionOptionSelections,
  right: SessionOptionSelections,
): boolean {
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every(
      (key) => Object.hasOwn(right, key) && left[key] === right[key],
    )
  );
}

export function seedThreadSessionOptionSelections(
  deps: Pick<AppDeps, "db" | "hub">,
  args: { thread: Thread; selections: SessionOptionSelections },
): void {
  if (Object.keys(args.selections).length === 0) {
    return;
  }
  writeThreadSessionOptionSelections(deps, {
    threadId: args.thread.id,
    environmentId: args.thread.environmentId,
    providerThreadId: "",
    selections: args.selections,
  });
}

function writeThreadSessionOptionSelections(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    threadId: string;
    environmentId: string | null;
    providerThreadId: string;
    selections: SessionOptionSelections;
  },
): void {
  const { selections, ...target } = args;
  appendThreadEvent(
    deps,
    threadSessionOptionStateEvent({
      ...target,
      kind: THREAD_SESSION_OPTION_SELECTIONS_STATE_KIND,
      payload: { selections },
    }),
  );
}

function threadSessionOptionStateEvent(
  args: {
    threadId: string;
    environmentId: string | null;
    providerThreadId: string;
  } & (
    | {
        kind: typeof THREAD_SESSION_OPTIONS_STATE_KIND;
        payload: ThreadSessionOptionsState;
      }
    | {
        kind: typeof THREAD_SESSION_OPTION_SELECTIONS_STATE_KIND;
        payload: ThreadSessionOptionSelectionsState;
      }
  ),
): AppendStoredThreadEventArgs {
  return {
    threadId: args.threadId,
    environmentId: args.environmentId,
    type: "thread/extensionState/updated",
    scope: threadScope(),
    data: {
      providerThreadId: args.providerThreadId,
      kind: args.kind,
      payload: args.payload,
    },
  };
}

export function resolveRetainedThreadSessionOptions(
  db: DbConnection,
  threadId: string,
): SessionOptionSelections {
  const state = readThreadSessionOptionState(db, threadId);
  return state.optionsReported
    ? retainedSessionOptionSelections(state.options, state.selections)
    : state.selections;
}

export function applyThreadSessionOptionPatch(
  deps: Pick<AppDeps, "db" | "hub">,
  args: { thread: Thread; patch: SessionOptionSelectionPatch },
): void {
  const state = readThreadSessionOptionState(deps.db, args.thread.id);
  const result = applySessionOptionSelectionPatch({
    options: state.options,
    selections: state.selections,
    patch: args.patch,
  });
  if (!result.ok) {
    throw new ApiError(400, "invalid_request", result.message);
  }
  if (
    state.providerThreadId === null ||
    sameSelections(state.selections, result.selections)
  ) {
    return;
  }
  writeThreadSessionOptionSelections(deps, {
    threadId: args.thread.id,
    environmentId: args.thread.environmentId,
    providerThreadId: state.providerThreadId,
    selections: result.selections,
  });
}

export function dropSettledThreadSessionOptionSelections(
  deps: Pick<AppDeps, "db" | "hub">,
  args: { threadId: string; environmentId: string | null },
): void {
  const state = readThreadSessionOptionState(deps.db, args.threadId);
  if (state.providerThreadId === null) {
    return;
  }
  const retained = retainedSessionOptionSelections(
    state.options,
    state.selections,
  );
  if (sameSelections(state.selections, retained)) {
    return;
  }
  writeThreadSessionOptionSelections(deps, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    providerThreadId: state.providerThreadId,
    selections: retained,
  });
}

export function listCarriedStickySessionOptionStates(
  db: DbQueryConnection,
  args: {
    cutoffSequence: number;
    environmentId: string | null;
    oldMaxSequence: number;
    threadId: string;
  },
): AppendStoredThreadEventArgs[] {
  const stickyEvidence = listStickyOptionIdsBefore(
    db,
    args.threadId,
    args.oldMaxSequence + 1,
  );
  if (stickyEvidence.length === 0) {
    return [];
  }
  const stickyIds = new Set(stickyEvidence.map((evidence) => evidence.id));
  const prefixStickyIds = new Set(
    stickyEvidence
      .filter((evidence) => evidence.firstSequence < args.cutoffSequence)
      .map((evidence) => evidence.id),
  );
  const prefixSelections = snapshotSessionOptionSelections(
    readThreadStateBefore(
      db,
      args.threadId,
      THREAD_SESSION_OPTION_SELECTIONS_STATE_KIND,
      args.cutoffSequence,
    ),
  );
  const currentSelections = snapshotSessionOptionSelections(
    readThreadStateBefore(
      db,
      args.threadId,
      THREAD_SESSION_OPTION_SELECTIONS_STATE_KIND,
      args.oldMaxSequence + 1,
    ),
  );
  const selections = Object.fromEntries([
    ...Object.entries(prefixSelections).filter(([id]) => !stickyIds.has(id)),
    ...Object.entries(currentSelections).filter(([id]) => stickyIds.has(id)),
  ]);
  if (
    sameSelections(prefixSelections, selections) &&
    [...stickyIds].every((id) => prefixStickyIds.has(id))
  ) {
    return [];
  }
  const prefixOptionsState = readThreadStateBefore(
    db,
    args.threadId,
    THREAD_SESSION_OPTIONS_STATE_KIND,
    args.cutoffSequence,
  );
  const target = {
    threadId: args.threadId,
    environmentId: args.environmentId,
    providerThreadId: prefixOptionsState?.providerThreadId ?? "",
  };
  const selectionsEvent = threadSessionOptionStateEvent({
    ...target,
    kind: THREAD_SESSION_OPTION_SELECTIONS_STATE_KIND,
    payload: { selections, stickyOptionIds: [...stickyIds] },
  });
  if (prefixOptionsState === null) {
    return [selectionsEvent];
  }
  const prefixOptions = snapshotSessionOptions(prefixOptionsState);
  const kept = retainedSessionOptionSelections(prefixOptions, selections);
  const undeclaredIds = new Set(
    Object.keys(selections).filter(
      (id) => stickyIds.has(id) && !Object.hasOwn(kept, id),
    ),
  );
  if (undeclaredIds.size === 0) {
    return [selectionsEvent];
  }
  const latestOptions = snapshotSessionOptions(
    readThreadStateBefore(
      db,
      args.threadId,
      THREAD_SESSION_OPTIONS_STATE_KIND,
      args.oldMaxSequence + 1,
    ),
  );
  return [
    threadSessionOptionStateEvent({
      ...target,
      kind: THREAD_SESSION_OPTIONS_STATE_KIND,
      payload: {
        options: [
          ...prefixOptions.filter((option) => !undeclaredIds.has(option.id)),
          ...latestOptions.filter((option) => undeclaredIds.has(option.id)),
        ],
      },
    }),
    selectionsEvent,
  ];
}
