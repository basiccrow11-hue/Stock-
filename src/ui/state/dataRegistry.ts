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

export async function loadCsvDatasets(): Promise<CsvDataset[]> {
  try {
    // Daily files imported before bars were filed under their session day may carry midnight stamps.
    const list = (await idb.all<CsvDataset>('datasets')).map((d) => (d.baseTimeframe === '1D' ? { ...d, bars: sessionStampDailyBars(d.bars).bars } : d));
    csvProvider.setDatasets(list);
    datasetsChanged();
    return list;
  } catch {
    return [];
  }
}

export async function saveCsvDataset(d: CsvDataset): Promise<void> {
  csvProvider.upsert(d);
  datasetsChanged();
  await idb.set('datasets', d.symbol.toUpperCase(), d);
}

export async function deleteCsvDataset(symbol: string): Promise<void> {
  csvProvider.remove(symbol);
  datasetsChanged();
  await idb.delete('datasets', symbol.toUpperCase());
}
