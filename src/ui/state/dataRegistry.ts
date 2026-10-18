/** Provider registry: the single place the UI obtains market-data providers from. */
import type { HistoricalDataProvider } from '../../core/data/provider';
import { DemoDataProvider } from '../../core/data/demoProvider';
import { CsvDataProvider, type CsvDataset } from '../../core/data/csvProvider';
import { sessionStampDailyBars } from '../../core/data/csv';
import { AlpacaProvider, PolygonProvider } from '../../core/data/vendorProviders';
import { getCredentials } from './credentials';
import { getSettings } from './settingsStore';
import { idb } from '../services/idb';

export const demoProvider = new DemoDataProvider();
export const csvProvider = new CsvDataProvider();
export const polygonProvider = new PolygonProvider(() => getCredentials());
export const alpacaProvider = new AlpacaProvider(() => ({ ...getCredentials(), alpacaFeed: getSettings().alpacaFeed }));

export const HISTORICAL_PROVIDERS: HistoricalDataProvider[] = [demoProvider, csvProvider, polygonProvider, alpacaProvider];

export function getProvider(id: string): HistoricalDataProvider {
  return HISTORICAL_PROVIDERS.find((p) => p.id === id) ?? demoProvider;
}

/** Called whenever the imported datasets change (loaded, saved, deleted), so screens listing them can refresh. */
const datasetListeners = new Set<() => void>();
export function onCsvDatasetsChanged(fn: () => void): () => void {
  datasetListeners.add(fn);
  return () => datasetListeners.delete(fn);
}
const datasetsChanged = () => datasetListeners.forEach((fn) => fn());

/**
 * A daily dataset with its bars filed under their session day (sessionStampDailyBars); any other
 * dataset, or one already filed that way, as it is. Daily files imported before bars were filed
 * under their session day, and backups of them, may carry midnight stamps, which would show each
 * day's bar the evening before.
 */
export function sessionStamped(d: CsvDataset): CsvDataset {
  if (d.baseTimeframe !== '1D') return d;
  const bars = sessionStampDailyBars(d.bars).bars;
  return bars.length === d.bars.length && bars.every((b, i) => b.time === d.bars[i].time) ? d : { ...d, bars };
}

/** The first read of the imported datasets (loadCsvDatasets), as the app opens; null until it starts. */
let firstLoad: Promise<CsvDataset[]> | null = null;

/**
 * Settles once the imported datasets have first been read from storage (at once if that has not
 * started): until then the CSV provider has none, though some may be imported.
 */
export function csvDatasetsLoaded(): Promise<unknown> {
  return firstLoad ?? Promise.resolve();
}

/** Reads the imported datasets from storage and shows them. Meanwhile the first read says the data is still loading. */
export function loadCsvDatasets(): Promise<CsvDataset[]> {
  if (firstLoad) return readCsvDatasets();
  csvProvider.setLoading(true);
  firstLoad = readCsvDatasets();
  return firstLoad;
}

async function readCsvDatasets(): Promise<CsvDataset[]> {
  try {
    const stored = await idb.all<CsvDataset>('datasets');
    const list = stored.map(sessionStamped);
    csvProvider.setDatasets(list);
    csvProvider.setLoading(false);
    datasetsChanged();
    // Saved back that way, so storage (which a backup reads) keeps no midnight stamps. In one
    // transaction each, so a dataset another tab has just saved is never replaced.
    for (const d of list.filter((d, i) => d !== stored[i]))
      await idb
        .modify<CsvDataset>('datasets', d.symbol.toUpperCase(), (cur) => {
          const next = cur && sessionStamped(cur);
          return next !== cur ? next : undefined;
        })
        .catch(() => undefined);
    return list;
  } catch {
    // None could be read: the CSV provider says there is none.
    csvProvider.setLoading(false);
    datasetsChanged();
    return [];
  }
}

/** Store an imported dataset, then show it: the list never has data a reload would not find. */
export async function saveCsvDataset(d: CsvDataset): Promise<void> {
  const stamped = sessionStamped(d);
  await idb.set('datasets', stamped.symbol.toUpperCase(), stamped);
  csvProvider.upsert(stamped);
  datasetsChanged();
}

/** Show a stored dataset this tab's list is missing (left so by a restore that stopped partway). */
export function showStoredCsvDataset(d: CsvDataset): void {
  csvProvider.upsert(sessionStamped(d));
  datasetsChanged();
}

export async function deleteCsvDataset(symbol: string): Promise<void> {
  csvProvider.remove(symbol);
  datasetsChanged();
  await idb.delete('datasets', symbol.toUpperCase());
}
