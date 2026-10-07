use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

#[derive(Clone)]
struct Key {
    frame: f64,
    value: f64,
    easing: String,
    bezier: Option<[f64; 4]>,
}
struct Channel {
    property: String,
    keys: Vec<Key>,
    before: String,
    after: String,
}
struct Layer {
    id: String,
    channels: Vec<Channel>,
}
struct Program {
    source: String,
    channels: Vec<Channel>,
    layers: Vec<Layer>,
    bytes: usize,
}
#[derive(Default)]
pub struct Engine {
    cache: HashMap<String, Arc<Program>>,
    order: VecDeque<String>,
    bytes: usize,
    compiles: u64,
    hits: u64,
    evictions: u64,
    steps: u64,
    samples: u64,
}
const BUDGET: usize = 16 * 1024 * 1024;
const MAX_PROGRAMS: usize = 128;
fn number(value: &Value, name: &str, default: Option<f64>) -> Result<f64, String> {
    value
        .get(name)
        .and_then(Value::as_f64)
        .or(default)
        .filter(|v| v.is_finite())
        .ok_or_else(|| format!("ANIMATION_VALUE: Invalid {name}"))
}
fn mode(value: &Value, name: &str) -> Result<String, String> {
    let m = value[name].as_str().unwrap_or("constant");
    if !["constant", "linear", "cycle", "cycleOffset", "pingpong"].contains(&m) {
        return Err("ANIMATION_EXTRAPOLATION: Unknown mode".into());
    }
    Ok(m.into())
}
fn channels(value: &Value, total: &mut usize) -> Result<Vec<Channel>, String> {
    let rows = value
        .as_array()
        .ok_or("ANIMATION_PROGRAM: Expected channels")?;
    if rows.len() > 1000 {
        return Err("ANIMATION_PROGRAM: Channel limit".into());
    }
    let mut output = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in rows {
        let property = row["property"]
            .as_str()
            .ok_or("ANIMATION_PROGRAM: Missing property")?
            .to_string();
        if !seen.insert(property.clone()) {
            return Err("DUPLICATE_ANIMATION: Duplicate property".into());
        }
        let raw = row["keys"]
            .as_array()
            .filter(|k| !k.is_empty())
            .ok_or("ANIMATION_PROGRAM: Expected keys")?;
        *total += raw.len();
        if *total > 100000 {
            return Err("KEYFRAME_LIMIT: Program exceeds 100000 keys".into());
        }
        let mut keys = Vec::new();
        for key in raw {
            let frame = number(key, "frame", None)?;
            let value = number(key, "value", None)?;
            if frame < 0.0 || frame.fract() != 0.0 {
                return Err("KEYFRAME_FRAME: Invalid key frame".into());
            }
            let easing = key["easing"].as_str().unwrap_or("linear");
            if ![
                "linear",
                "easeIn",
                "easeOut",
                "easeInOut",
                "hold",
                "spring",
                "bezier",
            ]
            .contains(&easing)
            {
                return Err("ANIMATION_EASING: Unknown easing".into());
            }
            let bezier = if let Some(values) = key["bezier"].as_array() {
                if values.len() != 4 {
                    return Err("ANIMATION_BEZIER: Invalid controls".into());
                }
                let mut b = [0.0; 4];
                for (i, v) in values.iter().enumerate() {
                    b[i] = v
                        .as_f64()
                        .filter(|v| v.is_finite())
                        .ok_or("ANIMATION_BEZIER: Nonfinite control")?;
                }
                if !(0.0..=1.0).contains(&b[0]) || !(0.0..=1.0).contains(&b[2]) {
                    return Err("ANIMATION_BEZIER: Invalid time controls".into());
                }
                Some(b)
            } else {
                None
            };
            keys.push(Key {
                frame,
                value,
                easing: easing.into(),
                bezier,
            });
        }
        keys.sort_by(|a, b| a.frame.total_cmp(&b.frame));
        if keys.windows(2).any(|p| p[0].frame == p[1].frame) {
            return Err("DUPLICATE_KEYFRAME: Duplicate key times".into());
        }
        output.push(Channel {
            property,
            keys,
            before: mode(row, "before")?,
            after: mode(row, "after")?,
        });
    }
    Ok(output)
}
fn compile(value: &Value) -> Result<Program, String> {
    let mut total = 0;
    let base_channels = channels(&value["animations"], &mut total)?;
    let mut layers = Vec::new();
    let mut ids = std::collections::HashSet::new();
    if let Some(raw) = value["layers"].as_array() {
        if raw.len() > 32 {
            return Err("ANIMATION_LAYER_LIMIT: More than 32 layers".into());
        }
        for layer in raw {
            let id = layer["id"]
                .as_str()
                .ok_or("ANIMATION_LAYER: Missing ID")?
                .to_string();
            if !ids.insert(id.clone()) {
                return Err("ANIMATION_LAYER: Duplicate ID".into());
            }
            let c = channels(&layer["channels"], &mut total)?;
            if c.len() > 64 || c.iter().any(|c| c.property.starts_with("animationLayers.")) {
                return Err("ANIMATION_LAYER: Invalid layer controls".into());
            }
            layers.push(Layer { id, channels: c });
        }
    }
    let source = serde_json::to_string(value).map_err(|e| e.to_string())?;
    let bytes = source.len() * 2 + total * 96 + 512;
    Ok(Program {
        source,
        channels: base_channels,
        layers,
        bytes,
    })
}
fn get(node: &Value, path: &str) -> Result<f64, String> {
    let mut current = node;
    for part in path.split('.') {
        if ["__proto__", "constructor", "prototype"].contains(&part) {
            return Err("ANIMATION_TARGET: Reserved path".into());
        }
        current = if let Some(array) = current.as_array() {
            array.get(
                part.parse::<usize>()
                    .map_err(|_| "ANIMATION_TARGET: Invalid index")?,
            )
        } else {
            current.get(part)
        }
        .ok_or("ANIMATION_TARGET: Missing property")?;
    }
    current
        .as_f64()
        .filter(|v| v.is_finite())
        .ok_or_else(|| format!("ANIMATION_TARGET: {path} is not numeric"))
}
fn set(node: &mut Value, path: &str, value: f64) -> Result<(), String> {
    if !value.is_finite() {
        return Err("ANIMATION_VALUE: Nonfinite result".into());
    }
    super::set_numeric_path(node, path, value).map_err(|e| format!("ANIMATION_TARGET: {e}"))
}
fn clamp(node: &mut Value) {
    for name in ["opacity", "reveal"] {
        if let Some(v) = node[name].as_f64() {
            node[name] = json!(v.clamp(0.0, 1.0));
        }
    }
}
impl Engine {
    fn sample(&mut self, channel: &Channel, frame: f64) -> Result<f64, String> {
        self.samples += 1;
        let keys = &channel.keys;
        let first = &keys[0];
        let last = keys.last().unwrap();
        let duration = last.frame - first.frame;
        let mut f = frame;
        let mut offset = 0.0;
        if duration > 0.0 && (frame < first.frame || frame > last.frame) {
            let mode = if frame < first.frame {
                &channel.before
            } else {
                &channel.after
            };
            if mode == "constant" {
                return Ok(if frame < first.frame {
                    first.value
                } else {
                    last.value
                });
            }
            if mode == "linear" {
                let (a, b) = if frame < first.frame {
                    (&keys[0], &keys[1])
                } else {
                    (&keys[keys.len() - 2], last)
                };
                return Ok(a.value + (b.value - a.value) * (frame - a.frame) / (b.frame - a.frame));
            }
            let phase = (frame - first.frame) / duration;
            let cycles = phase.floor();
            let fraction = phase - cycles;
            f = first.frame
                + if mode == "pingpong" && cycles.rem_euclid(2.0) != 0.0 {
                    1.0 - fraction
                } else {
                    fraction
                } * duration;
            if mode == "cycleOffset" {
                offset = cycles * (last.value - first.value);
            }
        }
        if f <= first.frame {
            return Ok(first.value + offset);
        }
        let mut low = 1;
        let mut high = keys.len();
        while low < high {
            self.steps += 1;
            let mid = (low + high) / 2;
            if f < keys[mid].frame {
                high = mid;
            } else {
                low = mid + 1;
            }
        }
        if low == keys.len() {
            return Ok(last.value + offset);
        }
        let a = &keys[low - 1];
        let b = &keys[low];
        let t = (f - a.frame) / (b.frame - a.frame);
        let amount = if a.easing == "bezier" {
            super::bezier(t, &a.bezier.map(|b| json!(b)).unwrap_or(Value::Null))?
        } else {
            super::easing(t, &a.easing)
        };
        Ok(offset + a.value + (b.value - a.value) * amount)
    }
    fn evaluate(&mut self, program: &Program, node: &mut Value, frame: f64) -> Result<(), String> {
        for channel in &program.channels {
            let value = self.sample(channel, frame)?;
            set(node, &channel.property, value)?;
        }
        clamp(node);
        let metadata = node["animationLayers"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        if metadata.len() != program.layers.len() {
            return Err("ANIMATION_LAYER: Metadata mismatch".into());
        }
        for (index, layer) in program.layers.iter().enumerate() {
            let meta = &metadata[index];
            if meta["id"].as_str() != Some(&layer.id) {
                return Err("ANIMATION_LAYER: ID mismatch".into());
            }
            for channel in &layer.channels {
                get(node, &channel.property)?;
            }
            let weight = number(meta, "weight", Some(1.0))?.clamp(0.0, 1.0);
            node["animationLayers"][index]["weight"] = json!(weight);
            let start = number(meta, "start", Some(0.0))?;
            let end = meta["end"].as_f64();
            let enabled = meta["enabled"].as_bool().unwrap_or(true);
            if !enabled || weight == 0.0 || frame < start || end.is_some_and(|end| frame >= end) {
                continue;
            }
            let rate = number(meta, "rate", Some(1.0))?;
            let local = (frame - start) * rate + number(meta, "offset", Some(0.0))?;
            if !local.is_finite() || rate.abs() > 1000.0 {
                return Err("ANIMATION_VALUE: Layer clock exceeds finite rate bounds".into());
            }
            for channel in &layer.channels {
                let value = self.sample(channel, local)?;
                let base = get(node, &channel.property)?;
                let mixed = match meta["blend"].as_str().unwrap_or("add") {
                    "add" => base + weight * value,
                    "multiply" => base * (1.0 + weight * (value - 1.0)),
                    "replace" => base + weight * (value - base),
                    _ => return Err("ANIMATION_LAYER: Unknown blend".into()),
                };
                set(node, &channel.property, mixed)?;
            }
        }
        clamp(node);
        Ok(())
    }
    pub fn handle(&mut self, request: &Value) -> Result<Value, String> {
        let frame = number(request, "frame", None)?;
        if frame < 0.0 {
            return Err("KEYFRAME_FRAME: Parent frame must be nonnegative".into());
        }
        let entries = request["entries"]
            .as_array()
            .ok_or("ANIMATION_PROGRAM: Expected entries")?;
        if entries.len() > 64 {
            return Err("ANIMATION_PROGRAM: Chunk limit 64".into());
        }
        let definitions = request["programs"].as_object();
        let cache_enabled = request["cache"].as_bool().unwrap_or(true);
        let missing: Vec<_> = entries
            .iter()
            .filter_map(|e| e["program"].as_str())
            .filter(|id| {
                !self.cache.contains_key(*id) && !definitions.is_some_and(|d| d.contains_key(*id))
            })
            .collect();
        if !missing.is_empty() {
            return Ok(json!({"version":1,"missing":missing}));
        }
        let mut local = HashMap::<String, Arc<Program>>::new();
        let mut result = Vec::new();
        for entry in entries {
            let id = entry["program"]
                .as_str()
                .ok_or("ANIMATION_PROGRAM: Missing program ID")?;
            if id.len() != 64 || !id.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err("ANIMATION_PROGRAM: Invalid ID".into());
            }
            let program = if let Some(program) = local.get(id) {
                program.clone()
            } else {
                let cached = if cache_enabled {
                    self.cache.get(id).cloned()
                } else {
                    None
                };
                let program = if let Some(program) = cached {
                    if let Some(raw) = definitions.and_then(|d| d.get(id)) {
                        if program.source
                            != serde_json::to_string(raw).map_err(|e| e.to_string())?
                        {
                            return Err(
                                "ANIMATION_PROGRAM: Key reused with changed definitions".into()
                            );
                        }
                    }
                    self.hits += 1;
                    self.order.retain(|key| key != id);
                    self.order.push_back(id.into());
                    program
                } else {
                    let raw = definitions
                        .and_then(|d| d.get(id))
                        .ok_or("ANIMATION_PROGRAM_MISSING: Missing definition")?;
                    let program = Arc::new(compile(raw)?);
                    self.compiles += 1;
                    if cache_enabled && program.bytes <= BUDGET {
                        while !self.order.is_empty()
                            && (self.bytes + program.bytes > BUDGET
                                || self.cache.len() >= MAX_PROGRAMS)
                        {
                            let oldest = self.order.pop_front().unwrap();
                            if let Some(old) = self.cache.remove(&oldest) {
                                self.bytes -= old.bytes;
                                self.evictions += 1;
                            }
                        }
                        self.bytes += program.bytes;
                        self.cache.insert(id.into(), program.clone());
                        self.order.push_back(id.into());
                    }
                    program
                };
                local.insert(id.into(), program.clone());
                program
            };
            let mut node = entry["node"].clone();
            self.evaluate(&program, &mut node, frame)?;
            result.push(node);
        }
        Ok(
            json!({"version":1,"nodes":result,"stats":{"compiles":self.compiles,"hits":self.hits,"evictions":self.evictions,"entries":self.cache.len(),"accountedBytes":self.bytes,"budgetBytes":BUDGET,"maxEntries":MAX_PROGRAMS,"binarySteps":self.steps,"samples":self.samples}}),
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cache_and_layers_seek() {
        let mut engine = Engine::default();
        let key = "a".repeat(64);
        let program = json!({"animations":[{"property":"x","keys":[{"frame":0,"value":10},{"frame":10,"value":20}],"after":"cycleOffset"}],"layers":[{"id":"delta","channels":[{"property":"x","keys":[{"frame":0,"value":2},{"frame":10,"value":4}]}]}]});
        let node = json!({"x":0,"animationLayers":[{"id":"delta","blend":"add","weight":0.5,"start":0,"rate":1,"offset":0}]});
        let first=engine.handle(&json!({"frame":25,"entries":[{"program":key,"node":node}],"programs":{key.clone():program},"cache":true})).unwrap();
        assert_eq!(first["nodes"][0]["x"], 37.0);
        let later=engine.handle(&json!({"frame":5,"entries":[{"program":key,"node":node}],"programs":{},"cache":true})).unwrap();
        assert_eq!(later["nodes"][0]["x"], 16.5);
        assert_eq!(later["stats"]["compiles"], 1);
        assert_eq!(later["stats"]["hits"], 1);
    }
    #[test]
    fn rejects_duplicates_and_unknown_extrapolation() {
        assert!(compile(&json!({"animations":[{"property":"x","keys":[{"frame":0,"value":1},{"frame":0,"value":2}]}]})).is_err());
        assert!(compile(&json!({"animations":[{"property":"x","keys":[{"frame":0,"value":1}],"after":"future"}]})).is_err());
    }
}
