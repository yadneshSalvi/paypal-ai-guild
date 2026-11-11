"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Gantt, ProjectModel } from "@bryntum/gantt-enterprise";
import { StringHelper } from "@bryntum/core-enterprise";
import { Scheduler } from "@bryntum/scheduler-enterprise";
import type { ScheduleEvaluation } from "@/scheduling/contracts";
import type { PersistedSchedule } from "@/scheduling/persisted";
import { buildBryntumProjectConfig } from "@/scheduling/configuration";
import { nativeScheduleAssistant, type NativeAssistantCallbacks } from "./native-schedule-assistant";
import "@bryntum/gantt-enterprise/gantt.css";
import "./scheduling.css";

interface Props {
  sheet: PersistedSchedule; evaluation: ScheduleEvaluation; selected: string;
  onSelect: (id: string) => void;
  onMove: (id: string, notBefore: string) => Promise<void>;
  preview: boolean; assistant?: NativeAssistantCallbacks;
}
type DatedTask = { name: string; startDate: Date; endDate: Date };
const museumDate = (date: Date, zone: string) => new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(date);
const taskDescription = (record: DatedTask, zone: string) => `${record.name}. Starts ${museumDate(record.startDate, zone)}. Finishes ${museumDate(record.endDate, zone)}. Museum time: ${zone}. Modelled forecast.`;
const taskTooltip = (record: DatedTask, zone: string) => `<div class="guild-native-tooltip"><strong>${StringHelper.encodeHtml(record.name)}</strong><p>Starts ${StringHelper.encodeHtml(museumDate(record.startDate, zone))}<br>Finishes ${StringHelper.encodeHtml(museumDate(record.endDate, zone))}</p><small>Museum time · ${StringHelper.encodeHtml(zone)}<br>Modelled forecast</small></div>`;
/** One native model owns both views. Drag finalization is always cancelled;
 * the owner's next action concerns a server-validated proposal instead. */
export default function NativeSchedule(props: Props) {
  const ganttElement = useRef<HTMLDivElement>(null), capacityElement = useRef<HTMLDivElement>(null);
  const latest = useRef(props); latest.current = props;
  const widgets = useRef<{ project: ProjectModel; gantt: Gantt; scheduler: Scheduler } | null>(null);
  const [view, setView] = useState<"work" | "capacity">("work"), [failure, setFailure] = useState<string | null>(null);
  const [shared, setShared] = useState(false);
  const tabId = useId();
  useEffect(() => {
    if (!ganttElement.current || !capacityElement.current) return;
    let cancelled = false;
    setShared(false);
    const project = new ProjectModel(buildBryntumProjectConfig(props.sheet.forecast));
    let gantt: Gantt | undefined, scheduler: Scheduler | undefined, resize: ResizeObserver | undefined;
    void (async () => {
      try {
        await project.commitAsync(); if (cancelled) return;
        const common = {
          project, startDate: new Date(props.sheet.forecast.startAt), endDate: new Date(props.sheet.forecast.horizonEndAt),
          viewPreset: "dayAndWeek", height: 490, rowHeight: 58, barMargin: 15,
          timeRanges: [{ id: "museum-opening", startDate: new Date(props.sheet.forecast.openingAt), name: "EXHIBITION OPENS", cls: "guild-opening-line" }],
          multiEventSelect: false,
          readOnly: props.preview,
          subGridConfigs: { locked: { width: Math.max(130, Math.min(360, ganttElement.current!.clientWidth * 0.38)) } },
        };
        gantt = new Gantt({ ...common, appendTo: ganttElement.current!,
          columns: [{ type: "name", text: "The work", flex: 1, minWidth: 125, editor: false }, { id: "work-duration", type: "duration", text: "Business time", width: 110, hidden: ganttElement.current!.clientWidth < 700, editor: false }],
          taskRenderer: ({ taskRecord, renderData }) => { (renderData as typeof renderData & { ariaLabel: string }).ariaLabel = taskDescription(taskRecord, props.sheet.forecast.timeZone); return StringHelper.encodeHtml(taskRecord.name); },
          features: { taskEdit: false, cellEdit: false, taskMenu: false, taskResize: false, taskDragCreate: false,
            taskTooltip: { cls: "guild-native-tooltip-popup", template: ({ taskRecord }: { taskRecord: DatedTask }) => taskTooltip(taskRecord, props.sheet.forecast.timeZone) },
            dependencies: { allowCreate: false }, criticalPaths: true, baselines: true, timeRanges: { showCurrentTimeLine: false },
            ai: props.assistant ? nativeScheduleAssistant({ commissionId: props.assistant.commissionId, onStatus: run => latest.current.assistant?.onStatus(run), onProposal: async id => { await latest.current.assistant?.onProposal(id); } }) : false,
          },
          listeners: {
            selectionChange: ({ selected }: { selected: { id: string | number }[] }) => { if (selected[0]) latest.current.onSelect(String(selected[0].id)); },
            beforeTaskDropFinalize: ({ context }) => {
              context.async = true; const id = context.taskRecords[0]?.id, date = (context as typeof context & { startDate?: Date }).startDate;
              context.finalize(false);
              if (id && date instanceof Date) void latest.current.onMove(String(id), date.toISOString());
            },
          },
        });
        scheduler = new Scheduler({ ...common, project: project as unknown as NonNullable<ConstructorParameters<typeof Scheduler>[0]>["project"], appendTo: capacityElement.current!,
          columns: [{ text: "Your guild", field: "name", flex: 1, minWidth: 125, editor: false }, { id: "provider-capacity", text: "Capacity", field: "maxUnits", width: 110, hidden: ganttElement.current!.clientWidth < 700, editor: false, renderer: ({ value }: { value: number }) => `${value / 100} at once` }],
          eventRenderer: ({ eventRecord, renderData }: { eventRecord: DatedTask; renderData: { ariaLabel?: string } }) => { renderData.ariaLabel = taskDescription(eventRecord, props.sheet.forecast.timeZone); return StringHelper.encodeHtml(eventRecord.name); },
          features: { eventEdit: false, eventMenu: false, scheduleMenu: false, cellEdit: false, eventResize: false, eventDragCreate: false, dependencies: { allowCreate: false }, timeRanges: { showCurrentTimeLine: false },
            eventTooltip: { cls: "guild-native-tooltip-popup", template: ({ eventRecord }: { eventRecord: DatedTask }) => taskTooltip(eventRecord, props.sheet.forecast.timeZone) },
          },
          listeners: {
            eventClick: ({ eventRecord }: { eventRecord: { id: string | number } }) => latest.current.onSelect(String(eventRecord.id)),
            beforeEventDropFinalize: ({ context }) => {
              context.async = true; const id = String(context.eventRecord.id), date = context.startDate.toISOString();
              context.finalize(false); void latest.current.onMove(id, date);
            },
          },
        });
        const same = Object.is(gantt.project, scheduler.project) && Object.is(gantt.taskStore, scheduler.eventStore)
          && Object.is(gantt.resourceStore, scheduler.resourceStore) && Object.is(gantt.assignmentStore, scheduler.assignmentStore)
          && Object.is(gantt.dependencyStore, scheduler.dependencyStore) && Object.is(gantt.project.calendarManagerStore, project.calendarManagerStore);
        if (!same) throw new Error("The native views did not share the same project stores.");
        widgets.current = { project, gantt, scheduler }; setShared(true); setFailure(null);
        resize = new ResizeObserver(() => {
          const width = ganttElement.current?.parentElement?.clientWidth ?? 0; if (!width) return;
          for (const widget of [gantt, scheduler]) {
            const locked = widget?.subGrids.locked; if (locked) locked.width = Math.max(130, Math.min(360, width * 0.38));
          }
          type Columns = { getById: (id: string) => { hidden: boolean } | undefined };
          const duration = (gantt?.columns as unknown as Columns | undefined)?.getById("work-duration");
          const capacity = (scheduler?.columns as unknown as Columns | undefined)?.getById("provider-capacity");
          if (duration) duration.hidden = width < 700; if (capacity) capacity.hidden = width < 700;
        });
        resize.observe(ganttElement.current!.parentElement!);
      } catch (error) { if (!cancelled) setFailure(error instanceof Error ? error.message : "The native schedule could not open."); }
    })();
    return () => { cancelled = true; resize?.disconnect(); widgets.current = null; gantt?.destroy(); scheduler?.destroy(); project.destroy(); };
  }, [props.sheet.digest]);
  useEffect(() => {
    const { gantt, scheduler } = widgets.current ?? {};
    if (gantt) { const record = gantt.taskStore.getById(props.selected); if (record) gantt.selectedRecord = record; }
    if (scheduler) { const record = scheduler.eventStore.getById(props.selected); if (record) scheduler.selectedEvents = [record as (typeof scheduler.selectedEvents)[number]]; }
  }, [props.selected, shared]);
  return <section className="native-schedule" aria-label="Native project schedule" data-shared-model={shared ? "verified" : "loading"}>
    <div className="schedule-view-switch" role="tablist" aria-label="Schedule view">
      {(["work", "capacity"] as const).map(name => <button key={name} id={`${tabId}-${name}-tab`} role="tab" tabIndex={view === name ? 0 : -1} aria-controls={`${tabId}-${name}`} aria-selected={view === name} onClick={() => setView(name)} onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? "work" : event.key === "End" ? "capacity" : name === "work" ? "capacity" : "work"; setView(next); document.getElementById(`${tabId}-${next}-tab`)?.focus(); } }}>{name === "work" ? "The work · Gantt" : "The guild · Scheduler"}</button>)}
      <span>{shared ? "One shared native project" : "Calculating the project…"}</span>
    </div>
    <p className="native-schedule-zone">Task details: museum time · {props.sheet.forecast.timeZone}. Timeline axis: {Intl.DateTimeFormat().resolvedOptions().timeZone}.</p>
    {failure && <p className="form-error" role="alert">{failure} The accessible task list remains available.</p>}
    <div id={`${tabId}-work`} className="native-schedule-canvas" hidden={view !== "work"} ref={ganttElement} role="tabpanel" aria-labelledby={`${tabId}-work-tab`}/>
    <div id={`${tabId}-capacity`} className="native-schedule-canvas" hidden={view !== "capacity"} ref={capacityElement} role="tabpanel" aria-labelledby={`${tabId}-capacity-tab`}/>
    <div className="schedule-key"><span><i className="critical"/> Critical path</span><span><i className="baseline"/> Saved planning baseline</span><span><i className="opening"/> Opening</span><small>{props.preview ? "Read-only proposal preview." : "Dragging proposes a change for review."}</small></div>
  </section>;
}
