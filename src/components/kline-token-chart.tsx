"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AreaChart,
  BarChart3,
  Brush,
  Camera,
  CandlestickChart,
  ChevronDown,
  Crosshair,
  Expand,
  Eye,
  EyeOff,
  Focus,
  Minus,
  MoveVertical,
  Redo2,
  Ruler,
  Settings2,
  Sparkles,
  TrendingUp,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { CandleType, Chart as KLineChart, KLineData, Overlay, OverlayCreate, Period } from "klinecharts";
import type { ChartPoint, Trade } from "@/lib/types";
import { money, tickerLabel } from "@/lib/utils";
import { buildCandles, type ChartTimeframe } from "@/components/token-chart";
import { useSiteTheme } from "@/hooks/use-site-theme";

const timeframes = ["1s", "30s", "1m", "5m", "15m", "1h", "4h", "1d"] as const;
const DEFAULT_BAR_SPACE = 18;
const RIGHT_EDGE_DISTANCE = 24;
type DisplayMode = "Price" | "MCap";
type IndicatorName = "MA" | "EMA" | "BOLL" | "SAR" | "VOL" | "MACD" | "RSI" | "KDJ";
type Tool = "cursor" | "straightLine" | "rayLine" | "horizontalStraightLine" | "verticalStraightLine" | "parallelStraightLine" | "fibonacciLine" | "brush" | "arcMeasure";
type SavedOverlay = Pick<Overlay, "name" | "points"> & Pick<OverlayCreate, "styles" | "extendData">;

type TokenChartProps = {
  data: ChartPoint[];
  trades?: Trade[];
  compact?: boolean;
  tokenName?: string;
  ticker?: string;
  tokenAddress?: string;
  totalSupply?: number;
};

function precisionFor(value: number) {
  if (!Number.isFinite(value) || value === 0) return 8;
  return Math.max(2, Math.min(10, Math.ceil(-Math.log10(Math.abs(value))) + 3));
}

function formatPrice(value: number, mode: DisplayMode) {
  if (!Number.isFinite(value)) return "-";
  if (mode === "MCap") return money(value, true);
  if (value === 0) return "$0";
  if (value < 0.000001) return `$${value.toFixed(10)}`;
  if (value < 0.01) return `$${value.toFixed(8)}`;
  return money(value);
}

function periodFor(timeframe: ChartTimeframe): Period {
  if (timeframe.endsWith("s")) return { type: "second", span: Number.parseInt(timeframe, 10) };
  if (timeframe.endsWith("m")) return { type: "minute", span: Number.parseInt(timeframe, 10) };
  if (timeframe.endsWith("h")) return { type: "hour", span: Number.parseInt(timeframe, 10) };
  return { type: "day", span: 1 };
}

/**
 * Professional K-line terminal powered exclusively by ArcOrigin's onchain candles.
 * No exchange or simulated market data is sent to the chart library.
 */
export function KLineTokenChart({
  data,
  trades = [],
  compact = false,
  tokenName = "Token",
  ticker = "TOKEN",
  tokenAddress = ticker,
  totalSupply = 1_000_000_000,
}: TokenChartProps) {
  const [siteTheme] = useSiteTheme();
  const displayTicker = tickerLabel(ticker);
  const [timeframe, setTimeframe] = useState<ChartTimeframe>("1m");
  const [displayMode, setDisplayMode] = useState<DisplayMode>("Price");
  const [activeIndicators, setActiveIndicators] = useState<Set<IndicatorName>>(new Set(["VOL"]));
  const [indicatorsOpen, setIndicatorsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chartTypeOpen, setChartTypeOpen] = useState(false);
  const [chartType, setChartType] = useState<CandleType>("candle_solid");
  const [showGrid, setShowGrid] = useState(true);
  const [showMarkers, setShowMarkers] = useState(true);
  const [tool, setTool] = useState<Tool>("cursor");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [snapshot, setSnapshot] = useState("");
  const [drawingHistory, setDrawingHistory] = useState<SavedOverlay[]>([]);
  const [redoHistory, setRedoHistory] = useState<SavedOverlay[]>([]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<KLineChart | null>(null);
  const dataRef = useRef<KLineData[]>([]);
  const indicatorIdsRef = useRef<Record<IndicatorName, string | null>>({ MA: null, EMA: null, BOLL: null, SAR: null, VOL: null, MACD: null, RSI: null, KDJ: null });
  const [ready, setReady] = useState(false);
  const storageKey = `arc-origin-chart:${tokenAddress.toLowerCase()}:${displayMode.toLowerCase()}`;

  const sourceCandles = useMemo(() => buildCandles(data, compact ? "1h" : timeframe), [compact, data, timeframe]);
  const multiplier = displayMode === "MCap" ? totalSupply : 1;
  const candles = useMemo<KLineData[]>(() => sourceCandles.map((candle) => ({
    timestamp: Number(candle.time) * 1000,
    open: candle.open * multiplier,
    high: candle.high * multiplier,
    low: candle.low * multiplier,
    close: candle.close * multiplier,
    volume: candle.volume,
    turnover: candle.volume,
  })), [multiplier, sourceCandles]);
  const latest = candles.at(-1);
  const activeChange = latest && latest.open > 0 ? ((latest.close / latest.open) - 1) * 100 : 0;

  useEffect(() => {
    dataRef.current = candles;
    const chart = chartRef.current;
    if (!chart) return;
    chart.setSymbol({ ticker: displayTicker, pricePrecision: precisionFor(latest?.close ?? 0.00000001), volumePrecision: 2 });
    chart.setPeriod(periodFor(compact ? "1h" : timeframe));
    chart.resetData();
    chart.setBarSpace(compact ? 9 : DEFAULT_BAR_SPACE);
    chart.setOffsetRightDistance(RIGHT_EDGE_DISTANCE);
    window.requestAnimationFrame(() => chart.scrollToRealTime());
  }, [candles, compact, displayTicker, latest?.close, timeframe]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let disposeChart: ((target: HTMLElement | KLineChart | string) => void) | null = null;

    async function mount() {
      const { dispose, init, registerOverlay } = await import("klinecharts");
      if (disposed || !containerRef.current) return;
      disposeChart = dispose;
      registerOverlay({
        name: "arcMeasure",
        totalStep: 3,
        needDefaultPointFigure: true,
        needDefaultXAxisFigure: true,
        needDefaultYAxisFigure: true,
        createPointFigures: ({ coordinates, overlay }) => {
          if (coordinates.length < 2) return [];
          const [start, end] = coordinates;
          const startValue = Number(overlay.points[0]?.value ?? 0);
          const endValue = Number(overlay.points[1]?.value ?? 0);
          const startTime = Number(overlay.points[0]?.timestamp ?? 0);
          const endTime = Number(overlay.points[1]?.timestamp ?? 0);
          const percent = startValue > 0 ? ((endValue / startValue) - 1) * 100 : 0;
          const durationSeconds = Math.abs(endTime - startTime) / 1000;
          const duration = durationSeconds >= 3600
            ? `${Math.floor(durationSeconds / 3600)}h ${Math.floor((durationSeconds % 3600) / 60)}m`
            : durationSeconds >= 60 ? `${Math.floor(durationSeconds / 60)}m ${Math.floor(durationSeconds % 60)}s` : `${durationSeconds.toFixed(0)}s`;
          const left = Math.min(start.x, end.x);
          const top = Math.min(start.y, end.y);
          const width = Math.max(1, Math.abs(end.x - start.x));
          const height = Math.max(1, Math.abs(end.y - start.y));
          const label = `${percent >= 0 ? "+" : ""}${percent.toFixed(2)}% · ${duration}`;
          return [
            { type: "rect", attrs: { x: left, y: top, width, height }, styles: { style: "fill", color: percent >= 0 ? "rgba(40,198,184,.12)" : "rgba(250,99,116,.12)", borderColor: percent >= 0 ? "#28c6b8" : "#fa6374", borderSize: 1 } },
            { type: "line", attrs: { coordinates: [start, end] }, styles: { color: percent >= 0 ? "#28c6b8" : "#fa6374", size: 1, style: "dashed" } },
            { type: "text", attrs: { x: left + width / 2, y: top + height / 2, text: label, align: "center", baseline: "middle" }, styles: { style: "fill", color: "#e6fffa", size: 10, family: "ui-monospace, monospace", weight: "600", backgroundColor: "#17202a", borderColor: "#39515b", borderSize: 1, borderRadius: 3, paddingLeft: 5, paddingRight: 5, paddingTop: 3, paddingBottom: 3 } },
          ];
        },
      });
      const light = siteTheme === "light";
      const chart = init(containerRef.current, {
        timezone: "Etc/UTC",
        styles: {
          grid: {
            show: true,
            horizontal: { show: true, size: 1, style: "dashed", dashedValue: [4, 4], color: light ? "rgba(120,140,165,.22)" : "rgba(56, 67, 73, .42)" },
            vertical: { show: true, size: 1, style: "dashed", dashedValue: [4, 4], color: light ? "rgba(120,140,165,.18)" : "rgba(56, 67, 73, .36)" },
          },
          candle: {
            type: "candle_solid",
            bar: {
              upColor: "#28c6b8", downColor: "#fa6374", noChangeColor: "#7d8b91",
              upBorderColor: "#28c6b8", downBorderColor: "#fa6374", noChangeBorderColor: "#7d8b91",
              upWickColor: "#28c6b8", downWickColor: "#fa6374", noChangeWickColor: "#7d8b91",
              compareRule: "current_open",
            },
            tooltip: { showRule: "none", showType: "standard" },
          },
          xAxis: { axisLine: { show: true, color: light ? "#d4deea" : "#273138", size: 1 }, tickLine: { show: false, color: light ? "#d4deea" : "#273138", size: 1, length: 0 }, tickText: { show: true, color: light ? "#65758b" : "#87939b", size: 10, family: "ui-monospace, SFMono-Regular, monospace", weight: "normal", marginStart: 4, marginEnd: 4 } },
          yAxis: { axisLine: { show: true, color: light ? "#d4deea" : "#273138", size: 1 }, tickLine: { show: false, color: light ? "#d4deea" : "#273138", size: 1, length: 0 }, tickText: { show: true, color: light ? "#65758b" : "#87939b", size: 10, family: "ui-monospace, SFMono-Regular, monospace", weight: "normal", marginStart: 4, marginEnd: 6 } },
          crosshair: {
            horizontal: { show: true, line: { show: true, style: "dashed", dashedValue: [4, 4], color: light ? "rgba(55,76,105,.42)" : "rgba(226,232,240,.45)", size: 1 }, text: { show: true, style: "fill", color: "#f8fafc", size: 10, family: "ui-monospace, monospace", weight: "normal", borderStyle: "solid", borderDashedValue: [], borderSize: 0, borderColor: "transparent", borderRadius: 2, backgroundColor: light ? "#52657d" : "#273138", paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2 }, features: [] },
            vertical: { show: true, line: { show: true, style: "dashed", dashedValue: [4, 4], color: light ? "rgba(55,76,105,.34)" : "rgba(226,232,240,.38)", size: 1 }, text: { show: true, style: "fill", color: "#f8fafc", size: 10, family: "ui-monospace, monospace", weight: "normal", borderStyle: "solid", borderDashedValue: [], borderSize: 0, borderColor: "transparent", borderRadius: 2, backgroundColor: light ? "#52657d" : "#273138", paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2 } },
          },
        },
      });
      if (!chart) return;
      chart.setDataLoader({
        getBars: ({ callback }) => callback(dataRef.current, { backward: false, forward: false }),
      });
      chart.setSymbol({ ticker: displayTicker, pricePrecision: 8, volumePrecision: 2 });
      chart.setPeriod(periodFor(compact ? "1h" : "1m"));
      chart.setBarSpace(compact ? 9 : DEFAULT_BAR_SPACE);
      chart.setOffsetRightDistance(RIGHT_EDGE_DISTANCE);
      chartRef.current = chart;
      setReady(true);
      window.requestAnimationFrame(() => {
        chart.resize();
        chart.scrollToRealTime();
      });
    }
    void mount();
    return () => {
      disposed = true;
      setReady(false);
      if (chartRef.current && disposeChart) disposeChart(chartRef.current);
      chartRef.current = null;
      indicatorIdsRef.current = { MA: null, EMA: null, BOLL: null, SAR: null, VOL: null, MACD: null, RSI: null, KDJ: null };
    };
  }, [compact, displayTicker, siteTheme]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!ready || !chart) return;
    chart.setStyles({ grid: { show: showGrid } });
  }, [ready, showGrid]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!ready || !chart) return;
    chart.setStyles({ candle: { type: chartType } });
  }, [chartType, ready]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!ready || !chart) return;
    for (const name of ["MA", "EMA", "BOLL", "SAR", "VOL", "MACD", "RSI", "KDJ"] as const) {
      const existing = indicatorIdsRef.current[name];
      const enabled = activeIndicators.has(name);
      if (enabled && !existing) {
        const overlayOnPrice = name === "MA" || name === "EMA" || name === "BOLL" || name === "SAR";
        indicatorIdsRef.current[name] = chart.createIndicator(
          overlayOnPrice ? { name, paneId: "candle_pane", ...(name === "MA" || name === "EMA" ? { calcParams: [20] } : {}) } : name,
          !overlayOnPrice,
        );
      }
      if (!enabled && existing) {
        chart.removeIndicator({ id: existing });
        indicatorIdsRef.current[name] = null;
      }
    }
  }, [activeIndicators, ready]);

  useEffect(() => {
    if (!ready || compact) return;
    chartRef.current?.removeOverlay({ groupId: "arc-origin-drawings" });
    setDrawingHistory([]);
    setRedoHistory([]);
    try {
      const saved = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]") as SavedOverlay[];
      if (!Array.isArray(saved) || saved.length === 0) return;
      chartRef.current?.createOverlay(saved.map((overlay) => ({ ...overlay, groupId: "arc-origin-drawings" })));
      setDrawingHistory(saved);
    } catch {
      window.localStorage.removeItem(storageKey);
    }
  }, [compact, ready, storageKey]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!ready || !chart) return;
    chart.removeOverlay({ groupId: "arc-origin-trades" });
    if (!showMarkers) return;
    const earliest = candles[0]?.timestamp ?? 0;
    const latestTimestamp = candles.at(-1)?.timestamp ?? 0;
    const markers: OverlayCreate[] = trades
      .filter((trade) => Number.isFinite(trade.timestamp) && (trade.timestamp ?? 0) * 1000 >= earliest && (trade.timestamp ?? 0) * 1000 <= latestTimestamp)
      .map((trade) => ({
        name: "simpleTag",
        groupId: "arc-origin-trades",
        points: [{ timestamp: (trade.timestamp ?? 0) * 1000, value: trade.price * multiplier }],
        extendData: `${trade.type === "Buy" ? "B" : "S"} $${trade.usdc.toFixed(2)}`,
        styles: {
          line: { color: trade.type === "Buy" ? "#28c6b8" : "#fa6374" },
          text: { color: trade.type === "Buy" ? "#6ee7d9" : "#fda4af" },
        },
      }));
    if (markers.length > 0) chart.createOverlay(markers);
  }, [candles, multiplier, ready, showMarkers, trades]);

  useEffect(() => {
    const handleFullscreen = () => setIsFullscreen(document.fullscreenElement === shellRef.current);
    document.addEventListener("fullscreenchange", handleFullscreen);
    return () => document.removeEventListener("fullscreenchange", handleFullscreen);
  }, []);

  const chooseTool = useCallback((nextTool: Tool) => {
    setTool(nextTool);
    if (nextTool === "cursor") return;
    const overlay: OverlayCreate = {
      name: nextTool,
      groupId: "arc-origin-drawings",
      onDrawEnd: ({ overlay: drawn }) => {
        const saved: SavedOverlay = { name: drawn.name, points: drawn.points, styles: drawn.styles ?? undefined, extendData: drawn.extendData };
        setDrawingHistory((current) => {
          const next = [...current, saved];
          window.localStorage.setItem(storageKey, JSON.stringify(next));
          return next;
        });
        setRedoHistory([]);
        setTool("cursor");
      },
    };
    chartRef.current?.createOverlay(overlay);
  }, [storageKey]);

  const toggleIndicator = useCallback((name: IndicatorName) => {
    setActiveIndicators((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }, []);

  const zoom = useCallback((factor: number) => chartRef.current?.zoomAtCoordinate(factor), []);
  const fit = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.scrollToRealTime();
    chart.setBarSpace(compact ? 9 : DEFAULT_BAR_SPACE);
    chart.setOffsetRightDistance(RIGHT_EDGE_DISTANCE);
  }, [compact]);
  const undoDrawing = useCallback(() => {
    setDrawingHistory((current) => {
      const removed = current.at(-1);
      if (!removed) return current;
      const next = current.slice(0, -1);
      const latestOverlay = (chartRef.current?.getOverlays({ groupId: "arc-origin-drawings" }) ?? []).at(-1);
      if (latestOverlay) chartRef.current?.removeOverlay({ id: latestOverlay.id });
      setRedoHistory((redo) => [...redo, removed]);
      window.localStorage.setItem(storageKey, JSON.stringify(next));
      return next;
    });
  }, [storageKey]);
  const redoDrawing = useCallback(() => {
    setRedoHistory((current) => {
      const restored = current.at(-1);
      if (!restored) return current;
      chartRef.current?.createOverlay({ ...restored, groupId: "arc-origin-drawings" });
      setDrawingHistory((history) => {
        const next = [...history, restored];
        window.localStorage.setItem(storageKey, JSON.stringify(next));
        return next;
      });
      return current.slice(0, -1);
    });
  }, [storageKey]);
  const clearDrawings = useCallback(() => {
    chartRef.current?.removeOverlay({ groupId: "arc-origin-drawings" });
    setDrawingHistory([]);
    setRedoHistory([]);
    window.localStorage.removeItem(storageKey);
  }, [storageKey]);
  const capture = useCallback(() => setSnapshot(chartRef.current?.getConvertPictureUrl(true, "png", "#111417") ?? ""), []);
  const toggleFullscreen = useCallback(async () => {
    if (!shellRef.current) return;
    if (document.fullscreenElement) await document.exitFullscreen(); else await shellRef.current.requestFullscreen();
  }, []);
  const moveToLatest = useCallback(() => chartRef.current?.scrollToRealTime(), []);

  if (compact) return <div ref={shellRef} className="h-36 overflow-hidden"><div ref={containerRef} className="h-36 w-full" aria-label="ArcOrigin onchain candlestick chart" /></div>;

  return <div ref={shellRef} className={`relative overflow-hidden bg-[#111417] ${isFullscreen ? "h-screen w-screen p-3" : "rounded-xl border border-line"}`}>
    <div className="relative z-20 flex min-h-12 flex-wrap items-center justify-between gap-2 border-b border-line bg-[#0e1114] px-2 py-1.5">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {timeframes.map((item) => <ChartButton key={item} active={timeframe === item} onClick={() => setTimeframe(item)}>{item}</ChartButton>)}
        <span className="mx-1 h-5 w-px bg-line" />
        <div className="relative">
          <ChartButton active={chartTypeOpen} onClick={() => { setChartTypeOpen((value) => !value); setIndicatorsOpen(false); setSettingsOpen(false); }}><CandlestickChart className="size-4" /><span className="sr-only">Chart type</span><ChevronDown className="size-3" /></ChartButton>
          {chartTypeOpen && <ChartMenu>
            <MenuItem label="Candles" active={chartType === "candle_solid"} icon={<CandlestickChart className="size-4" />} onClick={() => { setChartType("candle_solid"); setChartTypeOpen(false); }} />
            <MenuItem label="Hollow candles" active={chartType === "candle_stroke"} icon={<Sparkles className="size-4" />} onClick={() => { setChartType("candle_stroke"); setChartTypeOpen(false); }} />
            <MenuItem label="OHLC bars" active={chartType === "ohlc"} icon={<BarChart3 className="size-4" />} onClick={() => { setChartType("ohlc"); setChartTypeOpen(false); }} />
            <MenuItem label="Area" active={chartType === "area"} icon={<AreaChart className="size-4" />} onClick={() => { setChartType("area"); setChartTypeOpen(false); }} />
          </ChartMenu>}
        </div>
        <div className="relative">
          <ChartButton active={indicatorsOpen || activeIndicators.size > 1} onClick={() => { setIndicatorsOpen((value) => !value); setSettingsOpen(false); setChartTypeOpen(false); }}><Activity className="size-4" />Indicators<ChevronDown className="size-3" /></ChartButton>
          {indicatorsOpen && <ChartMenu>
            <MenuSection>Price overlays</MenuSection>
            <Toggle label="Moving average" value="MA 20" active={activeIndicators.has("MA")} onClick={() => toggleIndicator("MA")} />
            <Toggle label="Exponential MA" value="EMA 20" active={activeIndicators.has("EMA")} onClick={() => toggleIndicator("EMA")} />
            <Toggle label="Bollinger Bands" value="BOLL" active={activeIndicators.has("BOLL")} onClick={() => toggleIndicator("BOLL")} />
            <Toggle label="Parabolic SAR" value="SAR" active={activeIndicators.has("SAR")} onClick={() => toggleIndicator("SAR")} />
            <MenuSection>Lower panes</MenuSection>
            <Toggle label="Volume" value="Onchain USDC" active={activeIndicators.has("VOL")} onClick={() => toggleIndicator("VOL")} />
            <Toggle label="MACD" value="Momentum" active={activeIndicators.has("MACD")} onClick={() => toggleIndicator("MACD")} />
            <Toggle label="RSI" value="Relative strength" active={activeIndicators.has("RSI")} onClick={() => toggleIndicator("RSI")} />
            <Toggle label="KDJ" value="Stochastic oscillator" active={activeIndicators.has("KDJ")} onClick={() => toggleIndicator("KDJ")} />
          </ChartMenu>}
        </div>
        <span className="mx-1 h-5 w-px bg-line" />
        {(["Price", "MCap"] as const).map((item) => <ChartButton key={item} active={displayMode === item} onClick={() => setDisplayMode(item)}>{item}</ChartButton>)}
      </div>
      <div className="flex items-center gap-1">
        <IconButton label="Fit chart" onClick={fit}><Focus className="size-4" /></IconButton>
        <IconButton label="Zoom in" onClick={() => zoom(1.25)}><ZoomIn className="size-4" /></IconButton>
        <IconButton label="Zoom out" onClick={() => zoom(.8)}><ZoomOut className="size-4" /></IconButton>
        <IconButton label="Undo drawing" active={drawingHistory.length > 0} onClick={undoDrawing}><Undo2 className="size-4" /></IconButton>
        <IconButton label="Redo drawing" active={redoHistory.length > 0} onClick={redoDrawing}><Redo2 className="size-4" /></IconButton>
        <div className="relative"><IconButton label="Chart settings" active={settingsOpen} onClick={() => { setSettingsOpen((value) => !value); setIndicatorsOpen(false); setChartTypeOpen(false); }}><Settings2 className="size-4" /></IconButton>{settingsOpen && <ChartMenu right><Toggle label="Grid" value="Chart grid" active={showGrid} onClick={() => setShowGrid((value) => !value)} /><Toggle label="Trade markers" value="Verified trades" active={showMarkers} onClick={() => setShowMarkers((value) => !value)} /></ChartMenu>}</div>
        <IconButton label={isFullscreen ? "Exit fullscreen" : "Fullscreen"} active={isFullscreen} onClick={() => void toggleFullscreen()}><Expand className="size-4" /></IconButton>
        <IconButton label="Capture chart screenshot" onClick={capture}><Camera className="size-4" /></IconButton>
      </div>
    </div>
    <div className="grid grid-cols-[42px_minmax(0,1fr)]">
      <aside className="flex flex-col items-center gap-1 border-r border-line bg-[#0e1114] py-2">
        <IconButton label="Crosshair cursor" active={tool === "cursor"} onClick={() => chooseTool("cursor")}><Crosshair className="size-4" /></IconButton>
        <IconButton label="Draw trend line" active={tool === "straightLine"} onClick={() => chooseTool("straightLine")}><TrendingUp className="size-4" /></IconButton>
        <IconButton label="Draw ray" active={tool === "rayLine"} onClick={() => chooseTool("rayLine")}><TrendingUp className="size-4 rotate-12" /></IconButton>
        <IconButton label="Draw horizontal line" active={tool === "horizontalStraightLine"} onClick={() => chooseTool("horizontalStraightLine")}><Minus className="size-4" /></IconButton>
        <IconButton label="Draw vertical line" active={tool === "verticalStraightLine"} onClick={() => chooseTool("verticalStraightLine")}><MoveVertical className="size-4" /></IconButton>
        <IconButton label="Draw parallel channel" active={tool === "parallelStraightLine"} onClick={() => chooseTool("parallelStraightLine")}><BarChart3 className="size-4 rotate-90" /></IconButton>
        <IconButton label="Fibonacci retracement" active={tool === "fibonacciLine"} onClick={() => chooseTool("fibonacciLine")}><Activity className="size-4" /></IconButton>
        <IconButton label="Freehand brush" active={tool === "brush"} onClick={() => chooseTool("brush")}><Brush className="size-4" /></IconButton>
        <IconButton label="Measure price and time" active={tool === "arcMeasure"} onClick={() => chooseTool("arcMeasure")}><Ruler className="size-4" /></IconButton>
        <span className="my-1 h-px w-6 bg-line" />
        <IconButton label="Show trade markers" active={showMarkers} onClick={() => setShowMarkers((value) => !value)}>{showMarkers ? <Eye className="size-4" /> : <EyeOff className="size-4" />}</IconButton>
        <IconButton label="Clear drawings" onClick={clearDrawings}><Trash2 className="size-4" /></IconButton>
      </aside>
      <div className="relative min-w-0">
        {latest && <div className="pointer-events-none absolute left-4 top-3 z-10 flex max-w-[calc(100%-32px)] flex-wrap items-center gap-x-2 font-mono text-[10px]">
          <span className="text-slate-400">O {formatPrice(latest.open, displayMode)}</span>
          <span className="text-emerald-300">H {formatPrice(latest.high, displayMode)}</span>
          <span className="text-rose-300">L {formatPrice(latest.low, displayMode)}</span>
          <span className="text-white">C {formatPrice(latest.close, displayMode)}</span>
          <span className={activeChange >= 0 ? "text-emerald-300" : "text-rose-300"}>{activeChange >= 0 ? "+" : ""}{activeChange.toFixed(2)}%</span>
        </div>}
        <div ref={containerRef} className={isFullscreen ? "h-[calc(100vh-112px)] min-h-[480px] w-full" : "h-[480px] w-full"} aria-label={`${tokenName} onchain candlestick chart`} />
      </div>
    </div>
    <div className="flex min-h-10 items-center justify-end border-t border-line bg-[#0e1114] px-3 py-1"><div className="flex items-center gap-1"><ChartButton onClick={moveToLatest}>Latest</ChartButton><IconButton label="Reset chart" onClick={fit}><Focus className="size-3.5" /></IconButton></div></div>
    {snapshot && <div role="dialog" aria-label="Chart screenshot preview" className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4">
      <div className="w-full max-w-5xl rounded-2xl border border-line bg-[#11161a] p-4">
        <div className="mb-3 flex justify-between"><b className="text-white">{displayTicker} chart</b><button type="button" onClick={() => setSnapshot("")} className="text-xs text-slate-400">Close</button></div>
        {/* The generated source is an in-memory canvas data URL, not untrusted remote content. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={snapshot} alt={`${ticker} onchain chart`} className="max-h-[70vh] w-full rounded-xl object-contain" />
        <a href={snapshot} download={`${ticker.toLowerCase()}-onchain-chart.png`} className="mt-3 inline-flex rounded-lg bg-cyan px-3 py-2 text-xs font-semibold text-[#07110e]">Download PNG</a>
      </div>
    </div>}
  </div>;
}

function ChartButton({ active = false, children, onClick }: { active?: boolean; children: React.ReactNode; onClick: () => void }) { return <button type="button" aria-pressed={active} onClick={onClick} className={`inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium transition ${active ? "bg-cyan/15 text-[#a5f3d7]" : "text-slate-400 hover:bg-white/[.05] hover:text-white"}`}>{children}</button>; }
function IconButton({ label, active = false, children, onClick }: { label: string; active?: boolean; children: React.ReactNode; onClick: () => void }) { return <button type="button" aria-label={label} aria-pressed={active} onClick={onClick} className={`grid size-8 place-items-center rounded-md transition ${active ? "bg-cyan/15 text-[#a5f3d7]" : "text-slate-400 hover:bg-white/[.05] hover:text-white"}`}>{children}</button>; }
function ChartMenu({ children, right = false }: { children: React.ReactNode; right?: boolean }) { return <div className={`absolute top-10 z-40 max-h-[420px] w-60 overflow-y-auto rounded-lg border border-line bg-[#13191d] p-1.5 shadow-2xl ${right ? "right-0" : "left-0"}`}>{children}</div>; }
function MenuSection({ children }: { children: React.ReactNode }) { return <p className="px-2 pb-1 pt-2 font-mono text-[9px] uppercase tracking-[.18em] text-slate-600">{children}</p>; }
function MenuItem({ label, active, icon, onClick }: { label: string; active: boolean; icon: React.ReactNode; onClick: () => void }) { return <button type="button" onClick={onClick} className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-xs ${active ? "bg-cyan/10 text-emerald-200" : "text-slate-300 hover:bg-white/[.05]"}`}>{icon}{label}</button>; }
function Toggle({ label, value, active, onClick }: { label: string; value: string; active: boolean; onClick: () => void }) { return <button type="button" onClick={onClick} className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left hover:bg-white/[.05]"><span><span className="block text-xs text-slate-200">{label}</span><span className="block text-[10px] text-slate-500">{value}</span></span><span className={`h-4 w-7 rounded-full p-0.5 ${active ? "bg-cyan" : "bg-slate-700"}`}><span className={`block size-3 rounded-full bg-white transition ${active ? "translate-x-3" : ""}`} /></span></button>; }
