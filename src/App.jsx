import React, { useReducer, useMemo, useEffect, useState } from "react";

/* ---------------------------------------------------------
   PRICING CONSTANTS
--------------------------------------------------------- */
const MATERIALS = {
  // costPerGram derived from filament spool prices: PLA ₱900/kg,
  // PETG ₱2,000/2.5kg, ABS ₱850/kg. Update these if your suppliers change.
  PLA: { label: "PLA", costPerGram: 0.9, gramsPerHour: 20, density: 1.24 }, // g/cm3
  PETG: { label: "PETG", costPerGram: 0.8, gramsPerHour: 15, density: 1.27 },
  ABS: { label: "ABS", costPerGram: 0.85, gramsPerHour: 15, density: 1.04 },
};

const STRENGTH_PROFILES = {
  "Cosplay Light": { infill: 10, walls: 2, multiplier: 0.85 },
  Standard: { infill: 20, walls: 3, multiplier: 1.0 },
  "Battle Durable": { infill: 40, walls: 4, multiplier: 1.35 },
};

const CATEGORY_PRESETS = {
  Helmet: { height: 25, weight: 450 },
  Sword: { height: 90, weight: 350 },
  Armor: { height: 40, weight: 600 },
  "Small Prop": { height: 10, weight: 80 },
};

const LABOR_RATE_PER_HOUR = 40; // machine + labor, PHP
const ADDON_PRICES = { supportRemoval: 150, priming: 250 };
const RUSH_MULTIPLIER = 0.3;

const currency = (n) =>
  `\u20B1${n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/* ---------------------------------------------------------
   MESH PARSING (STL + OBJ) — pure functions, no dependencies
   Returns { volumeCm3, dimsCm: {x,y,z} } assuming the file's
   native units are millimeters (the near-universal convention
   for STL/OBJ exported by slicers and most 3D tools).
--------------------------------------------------------- */

// Signed tetrahedron volume contribution of one triangle, relative to origin.
// Summed over a closed, consistently-wound mesh this gives the true volume.
function signedTriVolume(v1, v2, v3) {
  return (
    (v1.x * (v2.y * v3.z - v3.y * v2.z) -
      v1.y * (v2.x * v3.z - v3.x * v2.z) +
      v1.z * (v2.x * v3.y - v3.x * v2.y)) /
    6.0
  );
}

function boundsFromExtent(min, max) {
  return {
    x: (max.x - min.x) / 10, // mm -> cm
    y: (max.y - min.y) / 10,
    z: (max.z - min.z) / 10,
  };
}

function measureMesh(triangles) {
  // triangles: array of [{x,y,z}, {x,y,z}, {x,y,z}]
  let volume = 0;
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };

  for (const [v1, v2, v3] of triangles) {
    volume += signedTriVolume(v1, v2, v3);
    for (const v of [v1, v2, v3]) {
      min.x = Math.min(min.x, v.x); max.x = Math.max(max.x, v.x);
      min.y = Math.min(min.y, v.y); max.y = Math.max(max.y, v.y);
      min.z = Math.min(min.z, v.z); max.z = Math.max(max.z, v.z);
    }
  }

  if (!triangles.length || !isFinite(min.x)) {
    throw new Error("No triangles found in file.");
  }

  const volumeMm3 = Math.abs(volume);
  return {
    volumeCm3: volumeMm3 / 1000,
    dimsCm: boundsFromExtent(min, max),
  };
}

function parseSTL(buffer) {
  const dv = new DataView(buffer);
  const triCountFromHeader = buffer.byteLength >= 84 ? dv.getUint32(80, true) : 0;
  const expectedBinarySize = 84 + triCountFromHeader * 50;
  const isBinary = buffer.byteLength === expectedBinarySize && triCountFromHeader > 0;

  const triangles = [];

  if (isBinary) {
    let offset = 84;
    for (let i = 0; i < triCountFromHeader; i++) {
      offset += 12; // skip normal
      const verts = [];
      for (let v = 0; v < 3; v++) {
        verts.push({
          x: dv.getFloat32(offset, true),
          y: dv.getFloat32(offset + 4, true),
          z: dv.getFloat32(offset + 8, true),
        });
        offset += 12;
      }
      offset += 2; // skip attribute byte count
      triangles.push(verts);
    }
  } else {
    const text = new TextDecoder().decode(buffer);
    const vertexRegex = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
    let match;
    let current = [];
    while ((match = vertexRegex.exec(text)) !== null) {
      current.push({
        x: parseFloat(match[1]),
        y: parseFloat(match[2]),
        z: parseFloat(match[3]),
      });
      if (current.length === 3) {
        triangles.push(current);
        current = [];
      }
    }
  }

  return measureMesh(triangles);
}

function parseOBJ(text) {
  const vertices = [];
  const triangles = [];

  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("v ")) {
      const parts = trimmed.split(/\s+/);
      vertices.push({
        x: parseFloat(parts[1]),
        y: parseFloat(parts[2]),
        z: parseFloat(parts[3]),
      });
    } else if (trimmed.startsWith("f ")) {
      const parts = trimmed.split(/\s+/).slice(1);
      // each token may be "v", "v/vt", "v/vt/vn", or "v//vn" — take the vertex index
      const idxs = parts.map((p) => {
        let i = parseInt(p.split("/")[0], 10);
        if (i < 0) i = vertices.length + i + 1; // negative = relative index
        return i - 1; // OBJ is 1-based
      });
      // fan-triangulate faces with more than 3 vertices
      for (let i = 1; i < idxs.length - 1; i++) {
        const a = vertices[idxs[0]];
        const b = vertices[idxs[i]];
        const c = vertices[idxs[i + 1]];
        if (a && b && c) triangles.push([a, b, c]);
      }
    }
  }

  return measureMesh(triangles);
}

async function parseMeshFile(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (ext === "stl") {
    const buffer = await file.arrayBuffer();
    return parseSTL(buffer);
  }
  if (ext === "obj") {
    const text = await file.text();
    return parseOBJ(text);
  }
  throw new Error("Unsupported file type.");
}

/* ---------------------------------------------------------
   STATE
--------------------------------------------------------- */
const initialState = {
  path: "upload", // 'upload' | 'category'
  file: null,
  fileVolumeCm3: null, // raw parsed solid volume, null until a file parses successfully
  fileWeight: "",
  fileHeight: "",
  parseStatus: "idle", // 'idle' | 'parsing' | 'done' | 'error'
  parseError: "",
  category: null,
  material: "PLA",
  strength: "Standard",
  addons: { supportRemoval: false, priming: false, rush: false },
};

function reducer(state, action) {
  switch (action.type) {
    case "SET_PATH":
      return { ...state, path: action.value, category: null };
    case "SET_FILE":
      return {
        ...state,
        file: action.value,
        fileVolumeCm3: null,
        parseStatus: action.value ? "parsing" : "idle",
        parseError: "",
      };
    case "SET_PARSE_RESULT":
      return {
        ...state,
        fileVolumeCm3: action.volumeCm3,
        fileHeight: action.heightCm.toFixed(1),
        parseStatus: "done",
        parseError: "",
      };
    case "SET_PARSE_ERROR":
      return { ...state, parseStatus: "error", parseError: action.message };
    case "SET_FIELD":
      return { ...state, [action.field]: action.value };
    case "SET_CATEGORY":
      return { ...state, category: action.value };
    case "SET_MATERIAL":
      return { ...state, material: action.value };
    case "SET_STRENGTH":
      return { ...state, strength: action.value };
    case "TOGGLE_ADDON":
      return {
        ...state,
        addons: { ...state.addons, [action.value]: !state.addons[action.value] },
      };
    case "RESET":
      return initialState;
    default:
      return state;
  }
}

/* ---------------------------------------------------------
   PRICE CALC (pure function, easy to unit test/reuse)
--------------------------------------------------------- */
function calculatePrice(state) {
  const weight =
    state.path === "upload"
      ? parseFloat(state.fileWeight) || 0
      : CATEGORY_PRESETS[state.category]?.weight || 0;

  const strength = STRENGTH_PROFILES[state.strength];
  const material = MATERIALS[state.material];

  const adjWeight = weight * strength.multiplier;
  const materialCost = adjWeight * material.costPerGram;
  const estHours = material.gramsPerHour > 0 ? adjWeight / material.gramsPerHour : 0;
  const laborCost = estHours * LABOR_RATE_PER_HOUR;
  const subtotal = materialCost + laborCost;

  let addonsFlat = 0;
  if (state.addons.supportRemoval) addonsFlat += ADDON_PRICES.supportRemoval;
  if (state.addons.priming) addonsFlat += ADDON_PRICES.priming;

  const rushSurcharge = state.addons.rush ? subtotal * RUSH_MULTIPLIER : 0;
  const total = subtotal + addonsFlat + rushSurcharge;

  return {
    weight,
    adjWeight,
    materialCost,
    laborCost,
    estHours,
    subtotal,
    addonsFlat,
    rushSurcharge,
    total,
    ready: weight > 0,
  };
}

/* ---------------------------------------------------------
   COMPONENT
--------------------------------------------------------- */
export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const price = useMemo(() => calculatePrice(state), [state]);
  const [showBreakdown, setShowBreakdown] = useState(false);

  // Parse the mesh whenever a new file is selected.
  useEffect(() => {
    if (!state.file) return;
    let cancelled = false;

    parseMeshFile(state.file)
      .then(({ volumeCm3, dimsCm }) => {
        if (cancelled) return;
        const heightCm = Math.max(dimsCm.x, dimsCm.y, dimsCm.z);
        dispatch({ type: "SET_PARSE_RESULT", volumeCm3, heightCm });
      })
      .catch((err) => {
        if (cancelled) return;
        dispatch({
          type: "SET_PARSE_ERROR",
          message: err.message || "Couldn't read that file — enter weight manually.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [state.file]);

  // Re-derive estimated weight whenever the parsed volume, material, or
  // strength preset changes. This stays editable afterward — typing in the
  // weight field just overrides the estimate until the next file/material change.
  useEffect(() => {
    if (state.fileVolumeCm3 == null) return;
    const density = MATERIALS[state.material].density;
    const estimatedGrams = state.fileVolumeCm3 * density;
    dispatch({ type: "SET_FIELD", field: "fileWeight", value: estimatedGrams.toFixed(0) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.fileVolumeCm3, state.material]);

  const handleFile = (e) => {
    const f = e.target.files?.[0] || null;
    if (f && !/\.(stl|obj)$/i.test(f.name)) {
      alert("Please upload a .STL or .OBJ file.");
      return;
    }
    dispatch({ type: "SET_FILE", value: f });
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 p-4 sm:p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        <header>
          <h1 className="text-2xl font-semibold">Cosplay Print Quote</h1>
        </header>

        {/* PATH SELECTOR */}
        <section className="bg-white border border-gray-200 p-4">
          <div className="flex gap-2 mb-4">
            <button
              onClick={() => dispatch({ type: "SET_PATH", value: "upload" })}
              className={`flex-1 py-2 px-4 text-sm font-medium border ${
                state.path === "upload"
                  ? "bg-gray-900 text-white border-gray-900"
                  : "bg-white text-gray-700 border-gray-300"
              }`}
            >
              Upload a file
            </button>
            <button
              onClick={() => dispatch({ type: "SET_PATH", value: "category" })}
              className={`flex-1 py-2 px-4 text-sm font-medium border ${
                state.path === "category"
                  ? "bg-gray-900 text-white border-gray-900"
                  : "bg-white text-gray-700 border-gray-300"
              }`}
            >
              Don't have a file
            </button>
          </div>

          {state.path === "upload" ? (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">STL / OBJ file</label>
                <input
                  type="file"
                  accept=".stl,.obj"
                  onChange={handleFile}
                  className="block w-full text-sm border border-gray-300 p-2"
                />
                {state.file && (
                  <p className="text-xs text-gray-500 mt-1">
                    Selected: {state.file.name} ({(state.file.size / 1024).toFixed(0)} KB)
                  </p>
                )}
                {state.parseStatus === "parsing" && (
                  <p className="text-xs text-gray-400 mt-1">Reading mesh…</p>
                )}
                {state.parseStatus === "done" && (
                  <p className="text-xs text-green-600 mt-1">
                    Parsed: {state.fileVolumeCm3.toFixed(1)} cm³
                  </p>
                )}
                {state.parseStatus === "error" && (
                  <p className="text-xs text-red-600 mt-1">{state.parseError}</p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">
                    Estimated weight (g)
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={state.fileWeight}
                    onChange={(e) =>
                      dispatch({ type: "SET_FIELD", field: "fileWeight", value: e.target.value })
                    }
                    placeholder="Auto-fills once a file is parsed"
                    className="w-full border border-gray-300 p-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Height (cm)</label>
                  <input
                    type="number"
                    min="0"
                    value={state.fileHeight}
                    onChange={(e) =>
                      dispatch({ type: "SET_FIELD", field: "fileHeight", value: e.target.value })
                    }
                    placeholder="Auto-fills once a file is parsed"
                    className="w-full border border-gray-300 p-2 text-sm"
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {Object.entries(CATEGORY_PRESETS).map(([name, preset]) => (
                <button
                  key={name}
                  onClick={() => dispatch({ type: "SET_CATEGORY", value: name })}
                  className={`text-left border p-3 text-sm ${
                    state.category === name
                      ? "border-gray-900 bg-gray-900 text-white"
                      : "border-gray-300 bg-white"
                  }`}
                >
                  <div className="font-medium">{name}</div>
                  <div
                    className={`text-xs mt-1 ${
                      state.category === name ? "text-gray-300" : "text-gray-500"
                    }`}
                  >
                    ~{preset.height}cm · ~{preset.weight}g
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* CONFIG PANEL */}
        <section className="bg-white border border-gray-200 p-4 space-y-5">
          <h2 className="font-medium">Configuration</h2>

          <div>
            <label className="block text-sm font-medium mb-2">Material</label>
            <div className="flex gap-2">
              {Object.keys(MATERIALS).map((m) => (
                <button
                  key={m}
                  onClick={() => dispatch({ type: "SET_MATERIAL", value: m })}
                  className={`flex-1 py-2 text-sm border ${
                    state.material === m
                      ? "bg-gray-900 text-white border-gray-900"
                      : "bg-white text-gray-700 border-gray-300"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Strength</label>
            <div className="flex flex-col sm:flex-row gap-2">
              {Object.entries(STRENGTH_PROFILES).map(([name, profile]) => (
                <button
                  key={name}
                  onClick={() => dispatch({ type: "SET_STRENGTH", value: name })}
                  className={`flex-1 text-left py-2 px-3 text-sm border ${
                    state.strength === name
                      ? "bg-gray-900 text-white border-gray-900"
                      : "bg-white text-gray-700 border-gray-300"
                  }`}
                >
                  <div>{name}</div>
                  <div
                    className={`text-xs ${
                      state.strength === name ? "text-gray-300" : "text-gray-400"
                    }`}
                  >
                    {profile.infill}% infill · {profile.walls} walls
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Add-ons</label>
            <div className="space-y-2">
              {[
                { key: "supportRemoval", label: `Support removal & cleanup (+${currency(ADDON_PRICES.supportRemoval)})` },
                { key: "priming", label: `Priming, paint-ready finish (+${currency(ADDON_PRICES.priming)})` },
                { key: "rush", label: `Rush delivery (+${RUSH_MULTIPLIER * 100}% of subtotal)` },
              ].map((addon) => (
                <label key={addon.key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={state.addons[addon.key]}
                    onChange={() => dispatch({ type: "TOGGLE_ADDON", value: addon.key })}
                    className="h-4 w-4"
                  />
                  {addon.label}
                </label>
              ))}
            </div>
          </div>
        </section>

        {/* PRICE SUMMARY */}
        <section className="bg-white border border-gray-200 p-4">
          {price.ready ? (
            <>
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-gray-500">Estimated total</span>
                <span className="text-3xl font-semibold">{currency(price.total)}</span>
              </div>

              <button
                onClick={() => setShowBreakdown((v) => !v)}
                className="text-xs text-gray-400 underline mt-2"
              >
                {showBreakdown ? "Hide" : "Show"} internal breakdown
              </button>

              {showBreakdown && (
                <div className="mt-3 space-y-1 text-sm text-gray-600 border-t border-gray-100 pt-3">
                  <Row label="Weight used" value={`${price.weight}g (adj. ${price.adjWeight.toFixed(0)}g)`} />
                  <Row label="Material cost" value={currency(price.materialCost)} />
                  <Row label="Est. print time" value={`${price.estHours.toFixed(1)} hrs`} />
                  <Row label="Labor / machine cost" value={currency(price.laborCost)} />
                  <Row label="Subtotal" value={currency(price.subtotal)} />
                  <Row label="Add-ons (flat)" value={currency(price.addonsFlat)} />
                  <Row label="Rush surcharge" value={currency(price.rushSurcharge)} />
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-gray-400">
              {state.path === "upload"
                ? "Enter an estimated weight to see the quote."
                : "Pick a category to see the quote."}
            </p>
          )}
        </section>

        <div className="flex items-center justify-between border-t border-gray-200 pt-4">
          <button
            onClick={() => dispatch({ type: "RESET" })}
            className="text-xs text-gray-400 underline"
          >
            Reset form
          </button>
          <p className="text-xs text-gray-500">
            Any questions? Contact me on{" "}
            <a
              href="https://www.facebook.com/verakkos/"
              target="_blank"
              rel="noopener noreferrer"
              className="underline text-gray-900"
            >
              Facebook
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex justify-between">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}