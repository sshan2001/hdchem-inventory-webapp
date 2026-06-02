import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Search, RefreshCw, Package, PlusCircle, MinusCircle, ClipboardList, Gauge, ChevronDown } from "lucide-react";
import { supabase } from "./supabaseClient";
import "./styles.css";

function fmtNum(value) {
  const n = Number(value || 0);
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 1000) / 1000);
}

function fmtSmart(value, digits = 1) {
  const n = Number(value || 0);
  return n.toLocaleString("ko-KR", {
    minimumFractionDigits: Number.isInteger(n) ? 0 : digits,
    maximumFractionDigits: digits,
  });
}

function todayText() {
  return new Date().toISOString().slice(0, 10);
}

const TANK_SOLVENT_RULES = {
  "우레탄": { drumL: 190, gravity: 0.87 },
  "메탄올": { drumL: 190, gravity: 0.79 },
  "락카": { drumL: 190, gravity: 0.87 },
  "에나멜": { drumL: 200, gravity: 0.72 },
  "톨루엔": { drumL: 190, gravity: 0.87 },
  "자일렌": { drumL: 190, gravity: 0.87 },
  "에폭시": { drumL: 190, gravity: 0.79 },
};

function getTankRule(itemName, tank) {
  return TANK_SOLVENT_RULES[itemName] || {
    drumL: Number(tank?.drum_size || 190),
    gravity: Number(tank?.specific_gravity || 1),
  };
}

function calcStocks(items, transactions) {
  const stock = {};
  for (const item of items) stock[item.id] = Number(item.initial_stock || 0);

  for (const tx of transactions) {
    if (tx.canceled) continue;
    const id = tx.item_id;
    const qty = Number(tx.qty || 0);
    if (!(id in stock)) stock[id] = 0;

    if (tx.tx_type === "입고") stock[id] += qty;
    else if (tx.tx_type === "출고") stock[id] -= qty;
    else if (tx.tx_type === "조정") stock[id] += qty;
  }
  return stock;
}

function convertStockToLiters(stockQty, item, tank) {
  const itemName = item?.name || tank?.items?.name || "";
  const unit = String(item?.unit || tank?.items?.unit || "").trim().toUpperCase();
  const rule = getTankRule(itemName, tank);
  const value = Number(stockQty || 0);

  if (unit === "L") return value;
  if (unit === "KG") return rule.gravity > 0 ? value / rule.gravity : value;
  if (unit === "DRUM") return value * rule.drumL;
  if (unit === "CAN" || unit === "말통") return value * 18;

  return value * rule.drumL;
}

function normalizeTankShape(tank) {
  const name = String(tank?.name || "");
  if (name.includes("TK-8") || name.includes("TK-9")) return "horizontal_round";
  return "vertical_round";
}

function calcTankSummaries(tanks, itemsById, stocks, latestMeasurements) {
  return tanks.map((tank) => {
    const item = tank.items || itemsById[tank.item_id] || {};
    const itemName = item.name || "";
    const latest = latestMeasurements.find((m) => Number(m.tank_id) === Number(tank.id));
    const bookStock = stocks[tank.item_id] || 0;
    const bookLiters = convertStockToLiters(bookStock, item, tank);

    const currentL = latest ? Number(latest.calculated_volume_l || 0) : bookLiters;
    const capacityL = Number(tank.capacity_l || 0);
    const deadL = Number(tank.dead_stock_l || 0);
    const availableL = Math.max(0, currentL - deadL);
    const rule = getTankRule(itemName, tank);
    const percent = capacityL > 0 ? Math.min(100, Math.max(0, currentL / capacityL * 100)) : 0;

    let status = "정상";
    let statusClass = "ok";
    if (percent >= 95) {
      status = "만재";
      statusClass = "full";
    } else if (percent < 30) {
      status = "부족";
      statusClass = "danger";
    } else if (percent < 70) {
      status = "주의";
      statusClass = "warn";
    }

    return {
      tank,
      item,
      itemName,
      latest,
      source: latest ? "최근 실측" : "장부재고",
      currentL,
      capacityL,
      deadL,
      availableL,
      percent,
      status,
      statusClass,
      kg: currentL * rule.gravity,
      drum: rule.drumL > 0 ? availableL / rule.drumL : 0,
      can: availableL / 18,
      visualShape: normalizeTankShape(tank),
    };
  });
}

function TankVisual({ percent, shape, name }) {
  const safe = Math.max(0, Math.min(100, Number(percent || 0)));
  const fillHeight = `${safe}%`;
  const fillWidth = `${safe}%`;

  if (shape === "horizontal_round") {
    return (
      <div className="tankStage horizontalStage" aria-label={`${name || "탱크"} ${safe.toFixed(1)}%`}>
        <div className="premiumTank horizontalTank">
          <div className="horizontalLiquid" style={{ width: fillWidth }} />
          <div className="tankRim rimLeft" />
          <div className="tankRim rimRight" />
          <div className="tankHighlight long" />
          <div className="tankBaseShadow" />
        </div>
      </div>
    );
  }

  return (
    <div className="tankStage" aria-label={`${name || "탱크"} ${safe.toFixed(1)}%`}>
      <div className="premiumTank verticalTank">
        <div className="verticalLiquid" style={{ height: fillHeight }} />
        <div className="topEllipse" />
        <div className="tankHighlight" />
        <div className="tankBaseShadow" />
      </div>
    </div>
  );
}

function App() {
  const [items, setItems] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [todayTransactions, setTodayTransactions] = useState([]);
  const [tanks, setTanks] = useState([]);
  const [tankMeasurements, setTankMeasurements] = useState([]);
  const [selectedItemId, setSelectedItemId] = useState("");
  const [txType, setTxType] = useState("출고");
  const [qty, setQty] = useState("");
  const [customer, setCustomer] = useState("");
  const [shipName, setShipName] = useState("");
  const [memo, setMemo] = useState("");
  const [userName, setUserName] = useState(localStorage.getItem("hdchem_user_name") || "직원");
  const [search, setSearch] = useState("");
  const [workDate, setWorkDate] = useState(todayText());
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("준비됨");
  const [tab, setTab] = useState("stock");
  const [expandedGroups, setExpandedGroups] = useState({});
  const [hideZeroStock, setHideZeroStock] = useState(false);

  const itemsById = useMemo(() => {
    const map = {};
    for (const item of items) map[item.id] = item;
    return map;
  }, [items]);

  const stocks = useMemo(() => calcStocks(items, transactions), [items, transactions]);

  const tankSummaries = useMemo(
    () => calcTankSummaries(tanks, itemsById, stocks, tankMeasurements),
    [tanks, itemsById, stocks, tankMeasurements]
  );

  const filteredItems = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return items;
    return items.filter((item) => `${item.category || ""} ${item.name || ""}`.toLowerCase().includes(keyword));
  }, [items, search]);

  const selectedItem = selectedItemId ? itemsById[selectedItemId] : null;
  const selectedStock = selectedItemId ? stocks[selectedItemId] ?? 0 : 0;

  async function loadData() {
    setLoading(true);
    setStatus("서버 조회 중...");

    try {
      const { data: itemRows, error: itemError } = await supabase
        .from("items")
        .select("id, category, name, unit, initial_stock, display_order")
        .order("display_order", { ascending: true })
        .order("id", { ascending: true });
      if (itemError) throw itemError;

      const { data: txRows, error: txError } = await supabase
        .from("transactions")
        .select("id, work_date, item_id, tx_type, qty, customer, ship_name, memo, created_at, canceled")
        .lte("work_date", workDate)
        .eq("canceled", false)
        .order("work_date", { ascending: true })
        .order("id", { ascending: true });
      if (txError) throw txError;

      const { data: todayRows, error: todayError } = await supabase
        .from("transactions")
        .select("id, work_date, item_id, tx_type, qty, customer, ship_name, memo, created_at, canceled")
        .eq("work_date", workDate)
        .eq("canceled", false)
        .order("id", { ascending: false });
      if (todayError) throw todayError;

      const { data: tankRows, error: tankError } = await supabase
        .from("tanks")
        .select("id, name, item_id, tank_type, tank_shape, capacity_l, dead_stock_l, specific_gravity, drum_size, can_size, display_order, active, items(name, category, unit)")
        .eq("active", true)
        .order("display_order", { ascending: true })
        .order("id", { ascending: true });
      if (tankError) throw tankError;

      const { data: measurementRows, error: measurementError } = await supabase
        .from("tank_measurements")
        .select("id, tank_id, measured_height_mm, calculated_volume_l, created_at")
        .order("id", { ascending: false })
        .limit(200);
      if (measurementError) throw measurementError;

      setItems(itemRows || []);
      setTransactions(txRows || []);
      setTodayTransactions(todayRows || []);
      setTanks(tankRows || []);
      setTankMeasurements(measurementRows || []);
      setStatus(`새로고침 완료 ${new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`);
    } catch (err) {
      console.error(err);
      setStatus("서버 조회 실패");
      alert(`서버 조회 실패\n${err.message || err}`);
    } finally {
      setLoading(false);
    }
  }

  async function saveTransaction() {
    if (!selectedItemId) {
      alert("품목을 선택해주세요.");
      return;
    }

    const amount = Number(qty);
    if (!amount || amount <= 0) {
      alert("수량은 0보다 큰 숫자로 입력해주세요.");
      return;
    }

    if (txType === "출고" && selectedStock - amount < 0) {
      const ok = confirm(`현재고보다 출고수량이 많습니다.\n\n현재고: ${fmtNum(selectedStock)}\n출고수량: ${fmtNum(amount)}\n예상재고: ${fmtNum(selectedStock - amount)}\n\n그래도 저장할까요?`);
      if (!ok) return;
    }

    localStorage.setItem("hdchem_user_name", userName || "직원");

    const payload = {
      work_date: workDate,
      item_id: Number(selectedItemId),
      tx_type: txType,
      qty: amount,
      customer: customer.trim(),
      ship_name: shipName.trim(),
      memo: memo.trim() ? `${memo.trim()} / 입력자:${userName || "직원"}` : `입력자:${userName || "직원"}`,
      canceled: false,
      client_tx_key: `${workDate}-${selectedItemId}-${txType}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    };

    setLoading(true);
    setStatus("저장 중...");

    try {
      const { error } = await supabase.from("transactions").insert(payload);
      if (error) throw error;

      setQty("");
      setCustomer("");
      setShipName("");
      setMemo("");
      setStatus("저장 완료");
      await loadData();
    } catch (err) {
      console.error(err);
      alert(`저장 실패\n${err.message || err}`);
      setStatus("저장 실패");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workDate]);

  useEffect(() => {
    const channel = supabase
      .channel("mobile_inventory_changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "transactions" }, () => loadData())
      .on("postgres_changes", { event: "*", schema: "public", table: "items" }, () => loadData())
      .on("postgres_changes", { event: "*", schema: "public", table: "tank_measurements" }, () => loadData())
      .subscribe();

    return () => supabase.removeChannel(channel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workDate]);

  const groupedItems = useMemo(() => {
    const groups = {};
    for (const item of filteredItems) {
      const currentStock = stocks[item.id] ?? 0;
      if (hideZeroStock && Number(currentStock || 0) === 0) continue;

      const key = item.category || "기타";
      if (!groups[key]) groups[key] = [];
      groups[key].push(item);
    }
    return groups;
  }, [filteredItems, stocks, hideZeroStock]);

  useEffect(() => {
    const keyword = search.trim();
    if (!keyword) return;

    const nextExpanded = {};
    for (const category of Object.keys(groupedItems)) {
      nextExpanded[category] = true;
    }
    setExpandedGroups(nextExpanded);
  }, [search, groupedItems]);

  function toggleGroup(category) {
    setExpandedGroups((prev) => ({
      ...prev,
      [category]: !prev[category],
    }));
  }

  function expandAllGroups() {
    const next = {};
    for (const category of Object.keys(groupedItems)) {
      next[category] = true;
    }
    setExpandedGroups(next);
  }

  function collapseAllGroups() {
    setExpandedGroups({});
  }

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>HDChem 재고관리</h1>
          <p>{status}</p>
        </div>
        <button className="iconButton" onClick={loadData} disabled={loading}>
          <RefreshCw size={20} />
        </button>
      </header>

      <section className="controls">
        <label>
          날짜
          <input type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} />
        </label>
        <label>
          사용자
          <input value={userName} onChange={(e) => setUserName(e.target.value)} />
        </label>
      </section>

      <nav className="tabs">
        <button className={tab === "stock" ? "active" : ""} onClick={() => setTab("stock")}>
          <Package size={17} /> 현재고
        </button>
        <button className={tab === "input" ? "active" : ""} onClick={() => setTab("input")}>
          <PlusCircle size={17} /> 입출고
        </button>
        <button className={tab === "today" ? "active" : ""} onClick={() => setTab("today")}>
          <ClipboardList size={17} /> 오늘내역
        </button>
        <button className={tab === "tanks" ? "active" : ""} onClick={() => setTab("tanks")}>
          <Gauge size={17} /> 탱크현황
        </button>
      </nav>

      {tab !== "tanks" && (
        <div className="searchBox">
          <Search size={18} />
          <input placeholder="품목명 또는 구분 검색" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      )}

      {tab === "stock" && (
        <section className="panel">
          <div className="stockToolbar">
            <button onClick={expandAllGroups}>전체 펼침</button>
            <button onClick={collapseAllGroups}>전체 접기</button>
            <button className={hideZeroStock ? "active" : ""} onClick={() => setHideZeroStock((v) => !v)}>
              0재고 숨김
            </button>
          </div>

          {Object.entries(groupedItems).length === 0 && <p className="empty">표시할 품목이 없습니다.</p>}

          {Object.entries(groupedItems).map(([category, list]) => {
            const isOpen = !!expandedGroups[category];
            const totalStock = list.reduce((sum, item) => sum + Number(stocks[item.id] || 0), 0);

            return (
              <div key={category} className={`group accordionGroup ${isOpen ? "open" : ""}`}>
                <button className="groupHeader" onClick={() => toggleGroup(category)}>
                  <div>
                    <h2>{category}</h2>
                    <span>{list.length}개 품목 · 합계 {fmtSmart(totalStock)}</span>
                  </div>
                  <ChevronDown size={20} />
                </button>

                {isOpen && (
                  <div className="groupBody">
                    {list.map((item) => (
                      <button key={item.id} className="itemRow compact" onClick={() => { setSelectedItemId(String(item.id)); setTab("input"); }}>
                        <span>
                          <b>{item.name}</b>
                          <small>{item.unit === "CAN" ? "말통" : item.unit}</small>
                        </span>
                        <strong>{fmtNum(stocks[item.id] ?? 0)}</strong>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}

      {tab === "input" && (
        <section className="panel">
          <div className="formCard">
            <label>
              품목
              <select value={selectedItemId} onChange={(e) => setSelectedItemId(e.target.value)}>
                <option value="">품목 선택</option>
                {items.map((item) => (
                  <option key={item.id} value={item.id}>[{item.category}] {item.name}</option>
                ))}
              </select>
            </label>

            {selectedItem && (
              <div className="stockSummary">
                <span>{selectedItem.name}</span>
                <strong>현재고 {fmtNum(selectedStock)}</strong>
              </div>
            )}

            <div className="typeButtons">
              <button className={txType === "입고" ? "in active" : "in"} onClick={() => setTxType("입고")}>
                <PlusCircle size={18} /> 입고
              </button>
              <button className={txType === "출고" ? "out active" : "out"} onClick={() => setTxType("출고")}>
                <MinusCircle size={18} /> 출고
              </button>
            </div>

            <label>수량<input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="수량 입력" /></label>
            <label>거래처<input value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="거래처" /></label>
            <label>선명<input value={shipName} onChange={(e) => setShipName(e.target.value)} placeholder="선박명" /></label>
            <label>비고/LOT<input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="LOT, 메모 등" /></label>

            <button className="saveButton" onClick={saveTransaction} disabled={loading}>
              {loading ? "처리 중..." : "저장"}
            </button>
          </div>
        </section>
      )}

      {tab === "today" && (
        <section className="panel">
          {todayTransactions.length === 0 && <p className="empty">오늘 거래내역이 없습니다.</p>}
          {todayTransactions.map((tx) => {
            const item = itemsById[tx.item_id] || {};
            const time = tx.created_at ? tx.created_at.slice(11, 16) : "";
            return (
              <div key={tx.id} className="txCard">
                <div className="txTop">
                  <strong>{item.name || `품목ID ${tx.item_id}`}</strong>
                  <span className={tx.tx_type === "입고" ? "badge in" : tx.tx_type === "출고" ? "badge out" : "badge"}>{tx.tx_type}</span>
                </div>
                <div className="txMeta">
                  <span>{time}</span>
                  <span>수량 {fmtNum(tx.qty)}</span>
                  {tx.customer && <span>{tx.customer}</span>}
                  {tx.ship_name && <span>{tx.ship_name}</span>}
                </div>
                {tx.memo && <p>{tx.memo}</p>}
              </div>
            );
          })}
        </section>
      )}

      {tab === "tanks" && (
        <section className="panel tankPanel">
          <div className="tankSummaryTop">
            <div><b>{tankSummaries.length}</b><span>탱크</span></div>
            <div><b>{tankSummaries.filter((t) => t.statusClass === "danger" || t.statusClass === "warn").length}</b><span>주의/부족</span></div>
          </div>

          {tankSummaries.length === 0 && <p className="empty">탱크 정보가 없습니다.</p>}

          {tankSummaries.map((s) => (
            <article key={s.tank.id} className="tankCard">
              <div className="tankCardTop">
                <div>
                  <h2>{s.tank.name}</h2>
                  <p>{s.itemName} · {s.source}</p>
                </div>
                <span className={`tankBadge ${s.statusClass}`}>{s.status}</span>
              </div>

              <TankVisual percent={s.percent} shape={s.visualShape} name={s.tank.name} />

              <div className="tankPercentLine">
                <strong>{fmtSmart(s.percent)}%</strong>
                <strong>{fmtSmart(s.currentL)} L</strong>
              </div>

              <div className="tankBar"><div style={{ width: `${s.percent}%` }} /></div>

              <div className="tankGrid">
                <div><span>사용가능</span><b>{fmtSmart(s.availableL)} L</b></div>
                <div><span>DRUM</span><b>{fmtSmart(s.drum)}</b></div>
                <div><span>말통</span><b>{fmtSmart(s.can)}</b></div>
                <div><span>KG</span><b>{fmtSmart(s.kg)}</b></div>
              </div>

              <footer className="tankFooter">
                <span>최대 {fmtSmart(s.capacityL)} L</span>
                <span>Dead {fmtSmart(s.deadL)} L</span>
              </footer>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
