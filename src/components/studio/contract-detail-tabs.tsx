"use client";

import { useRef } from "react";

const tabs = [
  { value: "artifact", label: "The submission" },
  { value: "contract", label: "The agreement" },
  { value: "evidence", label: "The checks" },
] as const;

export type ContractDetailTab = (typeof tabs)[number]["value"];

export function ContractDetailTabs({ id, value, passed, total, onSelect }: {
  id: string;
  value: ContractDetailTab;
  passed: number;
  total: number;
  onSelect: (value: ContractDetailTab) => boolean;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  function select(index: number, moveFocus: boolean) {
    const next = tabs[index]!.value;
    if (next !== value && !onSelect(next)) return;
    if (moveFocus) buttons.current[index]?.focus();
  }
  return <div className="contract-tabs" role="tablist" aria-label="Contract detail">
    {tabs.map((tab, index) => <button key={tab.value} type="button"
      ref={node => { buttons.current[index] = node; }}
      id={`${id}-${tab.value}`} role="tab" aria-selected={value === tab.value}
      aria-controls={`${id}-panel`} tabIndex={value === tab.value ? 0 : -1}
      onClick={() => select(index, false)}
      onKeyDown={event => {
        if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
        select(next, true);
      }}>
      {tab.label}{tab.value === "evidence" && <span aria-label={`${passed} of ${total} checks passed`}>{passed}/{total}</span>}
    </button>)}
  </div>;
}
