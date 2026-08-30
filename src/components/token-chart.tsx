"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
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
  RotateCcw,
  Ruler,
  Settings2,
  TrendingUp,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type {
  IChartApi,
  IPriceLine,
  ISeriesApi,
  ISeriesMarkersPluginApi,
  SeriesMarker,
  Time,
  UTCTimestamp,
} from "lightweight-charts";
import type { ChartPoint, Trade } from "@/lib/types";
import { money, tickerLabel } from "@/lib/utils";
import { useSiteTheme } from "@/hooks/use-site-theme";

const timeframes = ["1s", "30s", "1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type ChartTimeframe = (typeof timeframes)[number];
type DisplayMode = "Price" | "MCap";
type ScaleMode = "auto" | "log" | "%";
type DrawingTool = "cursor" | "trend" | "horizontal" | "vertical" | "measure";

const timeframeSeconds: Record<ChartTimeframe, number> = {
  "1s": 1,
  "30s": 30,
  "1m": 60,
  "5m": 5 * 60,
  "15m": 15 * 60,
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
  "1d": 24 * 60 * 60,
};

const lookbacks = [
  { label: "5m", seconds: 5 * 60 },
  { label: "1h", seconds: 60 * 60 },
  { label: "6h", seconds: 6 * 60 * 60 },
  { label: "1d", seconds: 24 * 60 * 60 },
  { label: "All", seconds: 0 },
] as const;

type Candle = {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type DrawingPoint = {
  time: UTCTimestamp;
  price: number;
};

type ChartDrawing =
  | { kind: "horizontal"; price: number }
  | { kind: "vertical"; time: UTCTimestamp }
  | { kind: "trend" | "measure"; start: DrawingPoint; end: DrawingPoint };

type TokenChartProps = {
  data: ChartPoint[];
  trades?: Trade[];
  compact?: boolean;
  tokenName?: string;
  ticker?: string;
  totalSupply?: number;
};

function tokenPrice(value: number) {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  if (value < 0.000001) return `$${value.toFixed(10)}`;
  if (value < 0.01) return `$${value.toFixed(8)}`;
  return money(value);
}

export function buildCandles(data: ChartPoint[], timeframe: ChartTimeframe): Candle[] {
  if (data.length === 0) return [];
  const fallbackStart = 1_700_000_000;
  const ticks = data.map((point, index) => ({
    price: point.price,
    volume: point.volume,
    timestamp: point.timestamp ?? fallbackStart + index * 60,
  })).filter((point) => Number.isFinite(point.price) && point.price > 0)
    .sort((left, right) => left.timestamp - right.timestamp);
  if (ticks.length === 0) return [];

  const bucketSize = timeframeSeconds[timeframe];
  const buckets = new Map<number, Candle>();
  let previousClose: number | undefined;

  for (const tick of ticks) {
    const bucket = Math.floor(tick.timestamp / bucketSize) * bucketSize;
    const existing = buckets.get(bucket);
    if (existing) {
      existing.high = Math.max(existing.high, tick.price);
      existing.low = Math.min(existing.low, tick.price);
      existing.close = tick.price;
      existing.volume += tick.volume;
    } else {
      const open = previousClose ?? tick.price;
      buckets.set(bucket, {
        time: bucket as UTCTimestamp,
        open,
        high: Math.max(open, tick.price),
        low: Math.min(open, tick.price),
        close: tick.price,
        volume: tick.volume,
      });
    }
    previousClose = tick.price;
  }

  return [...buckets.values()]
    .sort((left, right) => Number(left.time) - Number(right.time))
    .slice(-1_200);
}

export function TokenChart({
  data,
  trades = [],
  compact = false,
  tokenName = "Token",
  ticker = "TOKEN",
  totalSupply = 1_000_000_000,
}: TokenChartProps) {
  const [siteTheme] = useSiteTheme();
  const [timeframe, setTimeframe] = useState<ChartTimeframe>("1m");
  const [displayMode, setDisplayMode] = useState<DisplayMode>("Price");
  const [scaleMode, setScaleMode] = useState<ScaleMode>("auto");
  const [hoveredCandle, setHoveredCandle] = useState<Candle | null>(null);
  const [showSma, setShowSma] = useState(false);
  const [showEma, setShowEma] = useState(false);
  const [showVolume, setShowVolume] = useState(true);
  const [showMarkers, setShowMarkers] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [drawingTool, setDrawingTool] = useState<DrawingTool>("cursor");
  const [drawings, setDrawings] = useState<ChartDrawing[]>([]);
  const [redoDrawings, setRedoDrawings] = useState<ChartDrawing[]>([]);
  const [pendingDrawingPoint, setPendingDrawingPoint] = useState<DrawingPoint | null>(null);
  const [overlayVersion, setOverlayVersion] = useState(0);
  const [indicatorMenuOpen, setIndicatorMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [screenshotDataUrl, setScreenshotDataUrl] = useState("");
  const [ready, setReady] = useState(false);

  const shellRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const smaSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const emaSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const markerPluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const candleMapRef = useRef(new Map<number, Candle>());
  const drawingToolRef = useRef<DrawingTool>(drawingTool);
  const pendingDrawingPointRef = useRef<DrawingPoint | null>(pendingDrawingPoint);
  const displayMultiplierRef = useRef(1);

  const baseCandles = useMemo(
    () => buildCandles(data, compact ? "1h" : timeframe),
    [compact, data, timeframe],
  );
  const displayMultiplier = displayMode === "MCap" ? totalSupply : 1;
  const candles = useMemo(
    () => baseCandles.map((candle) => ({
      ...candle,
      open: candle.open * displayMultiplier,
      high: candle.high * displayMultiplier,
      low: candle.low * displayMultiplier,
      close: candle.close * displayMultiplier,
    })),
    [baseCandles, displayMultiplier],
  );
  const latestCandle = candles.at(-1);
  const activeCandle = hoveredCandle ?? latestCandle;
  const activeChange = activeCandle && activeCandle.open > 0
    ? (activeCandle.close / activeCandle.open - 1) * 100
    : 0;
  const valueFormatter = useCallback(
    (value: number) => displayMode === "MCap" ? money(value, true) : tokenPrice(value),
    [displayMode],
  );

  useEffect(() => {
    drawingToolRef.current = drawingTool;
    pendingDrawingPointRef.current = null;
    setPendingDrawingPoint(null);
  }, [drawingTool]);

  useEffect(() => {
    pendingDrawingPointRef.current = pendingDrawingPoint;
  }, [pendingDrawingPoint]);

  useEffect(() => {
    displayMultiplierRef.current = displayMultiplier;
  }, [displayMultiplier]);

  useEffect(() => {
    const handleFullscreen = () => setIsFullscreen(document.fullscreenElement === shellRef.current);
    document.addEventListener("fullscreenchange", handleFullscreen);
    return () => document.removeEventListener("fullscreenchange", handleFullscreen);
  }, []);

  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let visibleRangeListener: (() => void) | null = null;
    async function createTradingChart() {
      const container = containerRef.current;
      if (!container) return;
      const {
        CandlestickSeries,
        ColorType,
        createChart,
        createSeriesMarkers,
        CrosshairMode,
        HistogramSeries,
        LineSeries,
      } = await import("lightweight-charts");
      if (disposed || !containerRef.current) return;
      const light = siteTheme === "light";

      const chart = createChart(container, {
        autoSize: true,
        height: compact ? 144 : 480,
        layout: {
          background: { type: ColorType.Solid, color: "transparent" },
          textColor: light ? "#65758b" : "#8a9396",
          fontFamily: "ui-monospace, SFMono-Regular, monospace",
          fontSize: 10,
          attributionLogo: true,
        },
        grid: {
          vertLines: { color: light ? "rgba(120, 140, 165, 0.18)" : "rgba(37, 43, 45, 0.52)" },
          horzLines: { color: light ? "rgba(120, 140, 165, 0.22)" : "rgba(37, 43, 45, 0.62)" },
        },
        crosshair: {
          mode: CrosshairMode.Normal,
          vertLine: { color: light ? "rgba(55, 76, 105, 0.42)" : "rgba(226, 232, 240, 0.48)", style: 2, labelBackgroundColor: light ? "#52657d" : "#31383d" },
          horzLine: { color: light ? "rgba(55, 76, 105, 0.34)" : "rgba(226, 232, 240, 0.38)", style: 2, labelBackgroundColor: light ? "#52657d" : "#31383d" },
        },
        rightPriceScale: {
          borderColor: light ? "#d4deea" : "#252b2d",
          scaleMargins: { top: 0.08, bottom: 0.24 },
        },
        timeScale: {
          borderColor: light ? "#d4deea" : "#252b2d",
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 7,
          barSpacing: compact ? 7 : 10,
          minBarSpacing: 2,
        },
        handleScroll: !compact,
        handleScale: !compact,
        localization: { priceFormatter: tokenPrice },
      });

      const candleSeries = chart.addSeries(CandlestickSeries, {
        upColor: "#27c7b8",
        downColor: "#fb5f6d",
        borderVisible: false,
        wickUpColor: "#27c7b8",
        wickDownColor: "#fb5f6d",
        priceLineColor: "#79e7c5",
        priceLineWidth: 1,
        priceFormat: { type: "price", precision: 10, minMove: 0.0000000001 },
      });
      const volumeSeries = chart.addSeries(HistogramSeries, {
        priceScaleId: "",
        priceFormat: { type: "volume" },
        lastValueVisible: false,
        priceLineVisible: false,
      });
      volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      const smaSeries = chart.addSeries(LineSeries, {
        color: "#fbbf24",
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      const emaSeries = chart.addSeries(LineSeries, {
        color: "#a78bfa",
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });

      chartRef.current = chart;
      candleSeriesRef.current = candleSeries;
      volumeSeriesRef.current = volumeSeries;
      smaSeriesRef.current = smaSeries;
      emaSeriesRef.current = emaSeries;
      markerPluginRef.current = createSeriesMarkers(candleSeries, []);

      chart.subscribeCrosshairMove((parameter) => {
        if (typeof parameter.time !== "number") {
          setHoveredCandle(null);
          return;
        }
        setHoveredCandle(candleMapRef.current.get(parameter.time) ?? null);
      });
      chart.subscribeClick((parameter) => {
        const tool = drawingToolRef.current;
        if (tool === "cursor" || !parameter.point || typeof parameter.time !== "number") return;
        const displayedPrice = candleSeries.coordinateToPrice(parameter.point.y);
        if (displayedPrice === null || !Number.isFinite(displayedPrice)) return;
        const point = {
          time: parameter.time as UTCTimestamp,
          price: displayedPrice / displayMultiplierRef.current,
        };

        if (tool === "horizontal") {
          setDrawings((current) => [...current, { kind: "horizontal", price: point.price }]);
          setRedoDrawings([]);
          return;
        }
        if (tool === "vertical") {
          setDrawings((current) => [...current, { kind: "vertical", time: point.time }]);
          setRedoDrawings([]);
          return;
        }

        const start = pendingDrawingPointRef.current;
        if (!start) {
          pendingDrawingPointRef.current = point;
          setPendingDrawingPoint(point);
          return;
        }
        const drawing: ChartDrawing = { kind: tool, start, end: point };
        setDrawings((current) => [...current, drawing]);
        setRedoDrawings([]);
        pendingDrawingPointRef.current = null;
        setPendingDrawingPoint(null);
      });
      visibleRangeListener = () => setOverlayVersion((version) => version + 1);
      chart.timeScale().subscribeVisibleLogicalRangeChange(visibleRangeListener);
      resizeObserver = new ResizeObserver(() => setOverlayVersion((version) => version + 1));
      resizeObserver.observe(container);
      setReady(true);
    }
    void createTradingChart();
    return () => {
      disposed = true;
      setReady(false);
      if (visibleRangeListener) chartRef.current?.timeScale().unsubscribeVisibleLogicalRangeChange(visibleRangeListener);
      resizeObserver?.disconnect();
      chartRef.current?.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      smaSeriesRef.current = null;
      emaSeriesRef.current = null;
      markerPluginRef.current = null;
      priceLinesRef.current = [];
    };
  }, [compact, siteTheme]);

  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    const smaSeries = smaSeriesRef.current;
    const emaSeries = emaSeriesRef.current;
    if (!ready || !chart || !candleSeries || !volumeSeries || !smaSeries || !emaSeries) return;

    candleMapRef.current = new Map(candles.map((candle) => [Number(candle.time), candle]));
    setHoveredCandle(null);
    candleSeries.setData(candles.map((candle) => ({
      time: candle.time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    })));
    candleSeries.applyOptions({
      priceFormat: {
        type: "custom",
        formatter: valueFormatter,
        minMove: displayMode === "MCap" ? 0.01 : 0.0000000001,
      },
    });
    volumeSeries.setData(showVolume ? candles.map((candle) => ({
      time: candle.time,
      value: candle.volume,
      color: candle.close >= candle.open ? "rgba(39, 199, 184, 0.34)" : "rgba(251, 95, 109, 0.34)",
    })) : []);
    smaSeries.setData(showSma ? simpleMovingAverage(candles, 20) : []);
    emaSeries.setData(showEma ? exponentialMovingAverage(candles, 20) : []);

    markerPluginRef.current?.setMarkers(showMarkers
      ? buildTradeMarkers(trades, timeframe, new Set(candles.map((candle) => Number(candle.time))))
      : []);
    chart.applyOptions({
      localization: { priceFormatter: valueFormatter },
      grid: {
        vertLines: { color: showGrid ? "rgba(37, 43, 45, 0.52)" : "transparent" },
        horzLines: { color: showGrid ? "rgba(37, 43, 45, 0.62)" : "transparent" },
      },
    });
    chart.timeScale().applyOptions({ secondsVisible: timeframe === "1s" || timeframe === "30s" });
    chart.priceScale("right").applyOptions({ autoScale: true });
    if (compact) {
      chart.timeScale().fitContent();
    } else {
      const visibleBars = Math.max(60, Math.min(120, candles.length));
      chart.timeScale().setVisibleLogicalRange({
        from: candles.length - visibleBars,
        to: candles.length + 7,
      });
    }
  }, [
    candles,
    compact,
    displayMode,
    ready,
    showEma,
    showGrid,
    showMarkers,
    showSma,
    showVolume,
    timeframe,
    trades,
    valueFormatter,
  ]);

  useEffect(() => {
    if (!ready || !chartRef.current) return;
    void import("lightweight-charts").then(({ PriceScaleMode }) => {
      const mode = scaleMode === "log"
        ? PriceScaleMode.Logarithmic
        : scaleMode === "%"
          ? PriceScaleMode.Percentage
          : PriceScaleMode.Normal;
      chartRef.current?.priceScale("right").applyOptions({ mode, autoScale: true });
      if (scaleMode === "auto") {
        window.requestAnimationFrame(() => chartRef.current?.priceScale("right").applyOptions({ autoScale: true }));
      }
    });
  }, [displayMode, ready, scaleMode]);

  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!ready || !series) return;
    for (const priceLine of priceLinesRef.current) series.removePriceLine(priceLine);
    priceLinesRef.current = drawings
      .filter((drawing): drawing is Extract<ChartDrawing, { kind: "horizontal" }> => drawing.kind === "horizontal")
      .map((drawing) => series.createPriceLine({
      price: drawing.price * displayMultiplier,
      color: "#facc15",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: "Level",
    }));
  }, [displayMultiplier, drawings, ready]);

  const fitContent = useCallback(() => {
    chartRef.current?.timeScale().fitContent();
    chartRef.current?.priceScale("right").applyOptions({ autoScale: true });
  }, []);

  const zoom = useCallback((direction: "in" | "out") => {
    const timeScale = chartRef.current?.timeScale();
    const range = timeScale?.getVisibleLogicalRange();
    if (!timeScale || !range) return;
    const center = (range.from + range.to) / 2;
    const half = (range.to - range.from) / 2 * (direction === "in" ? 0.72 : 1.38);
    timeScale.setVisibleLogicalRange({ from: center - half, to: center + half });
  }, []);

  const setLookback = useCallback((seconds: number) => {
    const chart = chartRef.current;
    const latest = baseCandles.at(-1);
    if (!chart || !latest || seconds === 0) {
      chart?.timeScale().fitContent();
      return;
    }
    chart.timeScale().setVisibleRange({
      from: (Number(latest.time) - seconds) as UTCTimestamp,
      to: (Number(latest.time) + timeframeSeconds[timeframe] * 3) as UTCTimestamp,
    });
  }, [baseCandles, timeframe]);

  const undoDrawing = useCallback(() => {
    setDrawings((current) => {
      const removed = current.at(-1);
      if (removed === undefined) return current;
      setRedoDrawings((redo) => [...redo, removed]);
      return current.slice(0, -1);
    });
    setPendingDrawingPoint(null);
  }, []);

  const redoDrawing = useCallback(() => {
    setRedoDrawings((current) => {
      const restored = current.at(-1);
      if (restored === undefined) return current;
      setDrawings((existing) => [...existing, restored]);
      return current.slice(0, -1);
    });
  }, []);

  const clearDrawings = useCallback(() => {
    setDrawings([]);
    setRedoDrawings([]);
    setPendingDrawingPoint(null);
  }, []);

  const selectDrawingTool = useCallback((tool: DrawingTool) => {
    setDrawingTool(tool);
  }, []);

  const selectDisplayMode = useCallback((mode: DisplayMode) => {
    setDisplayMode(mode);
    setScaleMode("auto");
    window.requestAnimationFrame(() => chartRef.current?.priceScale("right").applyOptions({ autoScale: true }));
  }, []);

  const selectScaleMode = useCallback((mode: ScaleMode) => {
    setScaleMode(mode);
    if (mode === "auto") {
      window.requestAnimationFrame(() => {
        chartRef.current?.priceScale("right").applyOptions({ autoScale: true });
        chartRef.current?.timeScale().fitContent();
      });
    }
  }, []);

  const toggleFullscreen = useCallback(async () => {
    const shell = shellRef.current;
    if (!shell) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await shell.requestFullscreen();
  }, []);

  const captureScreenshot = useCallback(() => {
    const canvas = chartRef.current?.takeScreenshot(true, true);
    if (!canvas) return;
    setScreenshotDataUrl(canvas.toDataURL("image/png"));
  }, []);

  if (compact) {
    return <div ref={shellRef} className="h-36">
      <div ref={containerRef} className="h-36 w-full" aria-label="Interactive candlestick price chart"/>
    </div>;
  }

  return <div
    ref={shellRef}
    className={`relative overflow-hidden bg-[#111417] ${isFullscreen ? "h-screen w-screen p-3" : "rounded-xl border border-line"}`}
  >
    <div className="relative z-20 flex min-h-12 flex-wrap items-center justify-between gap-2 border-b border-line bg-[#0e1114] px-2 py-1.5">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1 overflow-visible">
        {timeframes.map((item) => <ChartTextButton
          key={item}
          active={timeframe === item}
          onClick={() => setTimeframe(item)}
        >{item}</ChartTextButton>)}
        <span className="mx-1 h-5 w-px shrink-0 bg-line"/>
        <ChartIconButton label="Candlestick chart" active><CandlestickChart className="size-4"/></ChartIconButton>
        <div className="relative">
          <ChartTextButton active={indicatorMenuOpen || showSma || showEma} onClick={() => {
            setIndicatorMenuOpen((open) => !open);
            setSettingsOpen(false);
          }}>
            <Activity className="size-4"/>Indicators<ChevronDown className="size-3"/>
          </ChartTextButton>
          {indicatorMenuOpen && <ChartMenu className="left-0">
            <MenuToggle label="SMA 20" detail="Simple moving average" active={showSma} onClick={() => setShowSma((value) => !value)}/>
            <MenuToggle label="EMA 20" detail="Exponential moving average" active={showEma} onClick={() => setShowEma((value) => !value)}/>
            <MenuToggle label="Volume" detail="Confirmed USDC volume" active={showVolume} onClick={() => setShowVolume((value) => !value)}/>
          </ChartMenu>}
        </div>
        <span className="mx-1 h-5 w-px shrink-0 bg-line"/>
        {(["Price", "MCap"] as const).map((mode) => <ChartTextButton
          key={mode}
          active={displayMode === mode}
          onClick={() => selectDisplayMode(mode)}
        >{mode}</ChartTextButton>)}
        <ChartIconButton label="Undo drawing" disabled={drawings.length === 0} onClick={undoDrawing}><Undo2 className="size-4"/></ChartIconButton>
        <ChartIconButton label="Redo drawing" disabled={redoDrawings.length === 0} onClick={redoDrawing}><Redo2 className="size-4"/></ChartIconButton>
      </div>
      <div className="flex items-center gap-1">
        <ChartIconButton label="Fit chart" onClick={fitContent}><Focus className="size-4"/></ChartIconButton>
        <ChartIconButton label="Zoom in" onClick={() => zoom("in")}><ZoomIn className="size-4"/></ChartIconButton>
        <ChartIconButton label="Zoom out" onClick={() => zoom("out")}><ZoomOut className="size-4"/></ChartIconButton>
        <div className="relative">
          <ChartIconButton label="Chart settings" active={settingsOpen} onClick={() => {
            setSettingsOpen((open) => !open);
            setIndicatorMenuOpen(false);
          }}><Settings2 className="size-4"/></ChartIconButton>
          {settingsOpen && <ChartMenu className="right-0">
            <MenuToggle label="Trade markers" detail="Confirmed pool trades" active={showMarkers} onClick={() => setShowMarkers((value) => !value)}/>
            <MenuToggle label="Grid" detail="Chart grid lines" active={showGrid} onClick={() => setShowGrid((value) => !value)}/>
            <MenuToggle label="Volume" detail="USDC histogram" active={showVolume} onClick={() => setShowVolume((value) => !value)}/>
          </ChartMenu>}
        </div>
        <ChartIconButton label={isFullscreen ? "Exit fullscreen" : "Fullscreen"} active={isFullscreen} onClick={() => void toggleFullscreen()}><Expand className="size-4"/></ChartIconButton>
        <ChartIconButton label="Capture chart screenshot" onClick={captureScreenshot}><Camera className="size-4"/></ChartIconButton>
      </div>
    </div>

    <div className="grid grid-cols-[42px_minmax(0,1fr)]">
      <div className="flex flex-col items-center gap-1 border-r border-line bg-[#0e1114] py-2">
        <ChartIconButton label="Crosshair cursor" active={drawingTool === "cursor"} onClick={() => selectDrawingTool("cursor")}><Crosshair className="size-4"/></ChartIconButton>
        <ChartIconButton label="Draw trend line" active={drawingTool === "trend"} onClick={() => selectDrawingTool("trend")}><TrendingUp className="size-4"/></ChartIconButton>
        <ChartIconButton label="Draw horizontal level" active={drawingTool === "horizontal"} onClick={() => selectDrawingTool("horizontal")}><Minus className="size-4"/></ChartIconButton>
        <ChartIconButton label="Draw vertical line" active={drawingTool === "vertical"} onClick={() => selectDrawingTool("vertical")}><MoveVertical className="size-4"/></ChartIconButton>
        <ChartIconButton label="Measure price and time" active={drawingTool === "measure"} onClick={() => selectDrawingTool("measure")}><Ruler className="size-4"/></ChartIconButton>
        <span className="my-1 h-px w-6 bg-line"/>
        <ChartIconButton label="Show or hide trade markers" active={showMarkers} onClick={() => setShowMarkers((value) => !value)}>{showMarkers ? <Eye className="size-4"/> : <EyeOff className="size-4"/>}</ChartIconButton>
        <ChartIconButton label="Clear drawings" disabled={drawings.length === 0 && !pendingDrawingPoint} onClick={clearDrawings}><Trash2 className="size-4"/></ChartIconButton>
      </div>

      <div
        className="relative min-w-0"
        onWheel={() => window.requestAnimationFrame(() => setOverlayVersion((version) => version + 1))}
        onPointerUp={() => window.requestAnimationFrame(() => setOverlayVersion((version) => version + 1))}
      >
        <div className="pointer-events-none absolute left-4 top-3 z-10 max-w-[calc(100%-32px)]">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="font-semibold text-white">{tokenName} · {timeframe}</span>
            <span className="text-slate-500">· Uniswap pool</span>
            {activeCandle && <>
              <span className="font-mono text-[10px] text-slate-500">O <b className="font-normal text-slate-300">{valueFormatter(activeCandle.open)}</b></span>
              <span className="font-mono text-[10px] text-slate-500">H <b className="font-normal text-emerald-300">{valueFormatter(activeCandle.high)}</b></span>
              <span className="font-mono text-[10px] text-slate-500">L <b className="font-normal text-rose-300">{valueFormatter(activeCandle.low)}</b></span>
              <span className="font-mono text-[10px] text-slate-500">C <b className="font-normal text-slate-300">{valueFormatter(activeCandle.close)}</b></span>
              <span className={`font-mono text-[10px] ${activeChange >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{activeChange >= 0 ? "+" : ""}{activeChange.toFixed(2)}%</span>
            </>}
          </div>
          <div className="mt-1 flex items-center gap-3 font-mono text-[10px]">
            {showVolume && <span className="text-slate-400">Volume <b className="font-normal text-cyan">{money(activeCandle?.volume ?? 0, true)}</b></span>}
            {showSma && <span className="text-amber-300">SMA 20</span>}
            {showEma && <span className="text-violet-300">EMA 20</span>}
            {drawingTool !== "cursor" && <span className="text-amber-200">{drawingInstruction(drawingTool, Boolean(pendingDrawingPoint))}</span>}
          </div>
        </div>
        <div
          ref={containerRef}
          className={isFullscreen ? "h-[calc(100vh-112px)] min-h-[480px] w-full" : "h-[480px] w-full"}
          aria-label="Interactive candlestick price chart"
        />
        <DrawingOverlay
          chart={chartRef.current}
          series={candleSeriesRef.current}
          drawings={drawings}
          multiplier={displayMultiplier}
          version={overlayVersion}
          height={containerRef.current?.clientHeight ?? 480}
        />
      </div>
    </div>

    <div className="flex min-h-10 flex-wrap items-center justify-between gap-2 border-t border-line bg-[#0e1114] px-3 py-1">
      <div className="flex items-center gap-1">{lookbacks.map((item) => <ChartTextButton key={item.label} onClick={() => setLookback(item.seconds)}>{item.label}</ChartTextButton>)}</div>
      <div className="flex items-center gap-1">
        {(["%", "log", "auto"] as const).map((mode) => <ChartTextButton key={mode} active={scaleMode === mode} onClick={() => selectScaleMode(mode)}>{mode}</ChartTextButton>)}
        <ChartIconButton label="Reset chart" onClick={fitContent}><RotateCcw className="size-3.5"/></ChartIconButton>
      </div>
    </div>

    {screenshotDataUrl && <div role="dialog" aria-label="Chart screenshot preview" className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4 backdrop-blur-sm">
      <div className="w-full max-w-5xl rounded-2xl border border-line bg-[#11161a] p-4 shadow-2xl">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div><p className="text-sm font-semibold text-white">Chart screenshot</p><p className="mt-1 text-[10px] text-slate-500">{tickerLabel(ticker)} · {timeframe} · {displayMode}</p></div>
          <button type="button" onClick={() => setScreenshotDataUrl("")} className="h-8 rounded-lg px-3 text-xs text-slate-400 transition hover:bg-white/[.05] hover:text-white">Close</button>
        </div>
        {/* The source is a locally generated canvas data URL, never remote user content. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={screenshotDataUrl} alt={`${ticker} chart screenshot preview`} className="max-h-[70vh] w-full rounded-xl border border-line bg-[#111417] object-contain"/>
        <div className="mt-3 flex justify-end">
          <a
            href={screenshotDataUrl}
            download={`${ticker.toLowerCase()}-${timeframe}-${Date.now()}.png`}
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-cyan px-4 text-sm font-semibold text-[#07110e] transition hover:bg-[#98efd5]"
          ><Camera className="size-4"/>Download PNG</a>
        </div>
      </div>
    </div>}
  </div>;
}

function DrawingOverlay({
  chart,
  series,
  drawings,
  multiplier,
  version,
  height,
}: {
  chart: IChartApi | null;
  series: ISeriesApi<"Candlestick"> | null;
  drawings: ChartDrawing[];
  multiplier: number;
  version: number;
  height: number;
}) {
  void version;
  if (!chart || !series) return null;

  return <svg className="pointer-events-none absolute inset-0 z-[5] size-full overflow-visible" aria-hidden="true">
    {drawings.map((drawing, index) => {
      if (drawing.kind === "horizontal") return null;
      if (drawing.kind === "vertical") {
        const x = chart.timeScale().timeToCoordinate(drawing.time);
        if (x === null) return null;
        return <g key={`vertical-${index}`}>
          <line x1={x} y1={0} x2={x} y2={height} stroke="#60a5fa" strokeWidth="1" strokeDasharray="5 5"/>
          <rect x={Math.max(2, x - 38)} y={height - 25} width="76" height="18" rx="4" fill="#172554"/>
          <text x={x} y={height - 16} textAnchor="middle" dominantBaseline="middle" fill="#bfdbfe" fontSize="9">{formatUtcTime(drawing.time)}</text>
        </g>;
      }

      const x1 = chart.timeScale().timeToCoordinate(drawing.start.time);
      const x2 = chart.timeScale().timeToCoordinate(drawing.end.time);
      const y1 = series.priceToCoordinate(drawing.start.price * multiplier);
      const y2 = series.priceToCoordinate(drawing.end.price * multiplier);
      if (x1 === null || x2 === null || y1 === null || y2 === null) return null;

      if (drawing.kind === "trend") {
        return <g key={`trend-${index}`}>
          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#38bdf8" strokeWidth="2"/>
          <circle cx={x1} cy={y1} r="3" fill="#111417" stroke="#38bdf8" strokeWidth="2"/>
          <circle cx={x2} cy={y2} r="3" fill="#111417" stroke="#38bdf8" strokeWidth="2"/>
        </g>;
      }

      const left = Math.min(x1, x2);
      const top = Math.min(y1, y2);
      const width = Math.max(1, Math.abs(x2 - x1));
      const boxHeight = Math.max(1, Math.abs(y2 - y1));
      const percent = drawing.start.price > 0
        ? (drawing.end.price / drawing.start.price - 1) * 100
        : 0;
      const duration = Math.abs(Number(drawing.end.time) - Number(drawing.start.time));
      const tone = percent >= 0 ? "#2dd4bf" : "#fb7185";
      const labelX = Math.min(Math.max(left + width / 2, 68), Math.max(68, (containerWidth(chart) ?? 800) - 68));
      const labelY = Math.max(16, top - 10);

      return <g key={`measure-${index}`}>
        <rect x={left} y={top} width={width} height={boxHeight} fill={percent >= 0 ? "rgba(45,212,191,.10)" : "rgba(251,113,133,.10)"} stroke={tone} strokeWidth="1" strokeDasharray="4 3"/>
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={tone} strokeWidth="1.5"/>
        <rect x={labelX - 66} y={labelY - 10} width="132" height="20" rx="5" fill="#11161a" stroke={tone} strokeWidth="1"/>
        <text x={labelX} y={labelY} textAnchor="middle" dominantBaseline="middle" fill={tone} fontSize="10" fontWeight="600">
          {percent >= 0 ? "+" : ""}{percent.toFixed(2)}% · {formatDuration(duration)}
        </text>
      </g>;
    })}
  </svg>;
}

function containerWidth(chart: IChartApi) {
  const range = chart.timeScale().getVisibleLogicalRange();
  if (!range) return null;
  const left = chart.timeScale().logicalToCoordinate(range.from);
  const right = chart.timeScale().logicalToCoordinate(range.to);
  if (left === null || right === null) return null;
  return Math.abs(right - left);
}

function drawingInstruction(tool: DrawingTool, hasStart: boolean) {
  if (tool === "horizontal") return "Click chart to place horizontal level";
  if (tool === "vertical") return "Click chart to place vertical line";
  if (tool === "trend") return hasStart ? "Click the trend line end point" : "Click the trend line start point";
  if (tool === "measure") return hasStart ? "Click the measurement end point" : "Click the measurement start point";
  return "";
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${(seconds / 3_600).toFixed(seconds < 10_800 ? 1 : 0)}h`;
  return `${(seconds / 86_400).toFixed(seconds < 259_200 ? 1 : 0)}d`;
}

function formatUtcTime(timestamp: UTCTimestamp) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(Number(timestamp) * 1_000));
}

function buildTradeMarkers(
  trades: Trade[],
  timeframe: ChartTimeframe,
  candleTimes: Set<number>,
): SeriesMarker<Time>[] {
  const bucketSize = timeframeSeconds[timeframe];
  return trades
    .filter((trade) => trade.timestamp !== undefined)
    .map((trade) => ({
      trade,
      time: Math.floor((trade.timestamp as number) / bucketSize) * bucketSize,
    }))
    .filter(({ time }) => candleTimes.has(time))
    .sort((left, right) => left.time - right.time)
    .map(({ trade, time }) => ({
      time: time as UTCTimestamp,
      position: trade.type === "Buy" ? "belowBar" as const : "aboveBar" as const,
      color: trade.type === "Buy" ? "#2dd4bf" : "#fb7185",
      shape: trade.type === "Buy" ? "arrowUp" as const : "arrowDown" as const,
      text: `${trade.type === "Buy" ? "B" : "S"} ${money(trade.usdc, true)}`,
      size: 1,
    }));
}

function simpleMovingAverage(candles: Candle[], period: number) {
  return candles.flatMap((candle, index) => {
    if (index < period - 1) return [];
    const window = candles.slice(index - period + 1, index + 1);
    return [{ time: candle.time, value: window.reduce((sum, item) => sum + item.close, 0) / period }];
  });
}

function exponentialMovingAverage(candles: Candle[], period: number) {
  if (candles.length === 0) return [];
  const multiplier = 2 / (period + 1);
  let previous = candles[0].close;
  return candles.map((candle, index) => {
    previous = index === 0 ? candle.close : candle.close * multiplier + previous * (1 - multiplier);
    return { time: candle.time, value: previous };
  });
}

function ChartIconButton({
  label,
  active = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return <button
    type="button"
    title={label}
    aria-label={label}
    aria-pressed={active}
    disabled={disabled}
    onClick={onClick}
    className="control-button grid size-8 shrink-0 place-items-center rounded-md transition disabled:cursor-not-allowed"
  >{children}</button>;
}

function ChartTextButton({
  active = false,
  onClick,
  children,
}: {
  active?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return <button
    type="button"
    aria-pressed={active}
    onClick={onClick}
    className="control-button flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs transition"
  >{children}</button>;
}

function ChartMenu({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={`absolute top-10 z-30 w-60 rounded-xl border border-line bg-[#11161a] p-2 shadow-2xl ${className ?? ""}`}>{children}</div>;
}

function MenuToggle({
  label,
  detail,
  active,
  onClick,
}: {
  label: string;
  detail: string;
  active: boolean;
  onClick: () => void;
}) {
  return <button type="button" aria-pressed={active} onClick={onClick} className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-white/[.04]">
    <span><span className="block text-xs font-medium text-slate-200">{label}</span><span className="mt-0.5 block text-[10px] text-slate-600">{detail}</span></span>
    <span className={`h-4 w-7 rounded-full p-0.5 transition ${active ? "bg-cyan" : "bg-white/10"}`}><span className={`block size-3 rounded-full bg-[#08100e] transition-transform ${active ? "translate-x-3" : ""}`}/></span>
  </button>;
}
