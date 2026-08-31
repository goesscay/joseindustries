import { useEffect, useRef, useState } from "react";
import { Select, Spin } from "antd";
import type { SelectProps } from "antd";
import { api } from "../api/client";

export interface RemoteSelectOption {
  value: number;
  label: string;
}

interface RemoteSelectProps<T> extends Omit<SelectProps<number>, "options" | "onSearch" | "filterOption" | "notFoundContent"> {
  /** API path to search against - must support the existing `?search=` and
   * `?perPage=` query params every list route in this app already offers
   * (customers, vendors, items, ...). */
  searchPath: string;
  /** Turns one raw record from that endpoint's `data` array into an option. */
  mapOption: (record: T) => RemoteSelectOption;
  /**
   * Options that must always stay present regardless of the current search
   * text or which page of results the server last returned - typically the
   * record currently selected when this field first opens (e.g. editing an
   * existing document), plus anything just created inline (e.g. via a
   * "quick add" modal) before this component's own next search re-fetches.
   */
  extraOptions?: RemoteSelectOption[];
}

const DEBOUNCE_MS = 300;
const PAGE_SIZE = 50;

/**
 * A Select that searches the server as the user types, instead of filtering
 * a client-side list loaded once up front. Every "pick a customer/vendor/
 * item" dropdown in this app used to load a single fixed page (capped at
 * 100 rows server-side) and filter only within it - so typing a name that
 * sorted past that page, or existed beyond the cap, found nothing, and
 * (for an already-selected record in the same situation) the field showed
 * a raw id instead of a name. This component instead re-queries
 * `searchPath` on every keystroke (debounced), so results always reflect
 * the full table, not just whatever page happened to load first.
 */
export function RemoteSelect<T>({ searchPath, mapOption, extraOptions, value, ...rest }: RemoteSelectProps<T>) {
  const [options, setOptions] = useState<RemoteSelectOption[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const requestIdRef = useRef(0);
  // Whichever option's label was last resolved for the currently-selected
  // value - kept independently of the live search results, so typing a new
  // search term to look for a *different* record doesn't blank out the
  // already-selected one's label just because the newest results (or a
  // fresh extraOptions array from the caller) no longer happen to include
  // it.
  const [selectedOption, setSelectedOption] = useState<RemoteSelectOption | null>(null);

  async function runSearch(term: string) {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const res = await api.get<{ data: T[] }>(`${searchPath}?search=${encodeURIComponent(term)}&perPage=${PAGE_SIZE}`);
      if (requestId !== requestIdRef.current) return; // a newer search superseded this one - ignore
      setOptions(res.data.map(mapOption));
    } catch {
      // Leave whichever options are already shown - a transient search
      // failure shouldn't wipe the dropdown out from under the user.
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }

  // Load an initial page (no search term) once on mount, so the dropdown
  // isn't empty before the user has typed anything.
  useEffect(() => {
    void runSearch("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchPath]);

  function handleSearch(term: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void runSearch(term), DEBOUNCE_MS);
  }

  // Merge in whatever the caller says must always be selectable, then
  // whichever option we've personally resolved for the current value in
  // the past - deduplicated, always listed first so neither is ever pushed
  // out by a full results page.
  const knownOptions = (() => {
    const seen = new Set<number>();
    const merged: RemoteSelectOption[] = [];
    for (const o of [...(extraOptions ?? []), ...(selectedOption ? [selectedOption] : []), ...options]) {
      if (!seen.has(o.value)) {
        seen.add(o.value);
        merged.push(o);
      }
    }
    return merged;
  })();

  // Whenever the current value resolves to a real option somewhere in what
  // we know about, remember its label; clear it once the field is emptied.
  useEffect(() => {
    if (value === undefined || value === null) {
      setSelectedOption(null);
      return;
    }
    const found = knownOptions.find((o) => o.value === value);
    if (found) setSelectedOption(found);
    // Only re-run when the value itself changes or the pool of known
    // options grows - not on every knownOptions identity change (it's
    // recomputed every render), to avoid a redundant extra state update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, options, extraOptions]);

  return (
    <Select
      showSearch
      value={value}
      options={knownOptions}
      onSearch={handleSearch}
      filterOption={false}
      notFoundContent={loading ? <Spin size="small" /> : undefined}
      {...rest}
    />
  );
}
