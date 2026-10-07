use serde_json::{Value, json};
use std::io::{self, BufRead, Write};
mod animation;
mod raster;
mod shading;

fn easing(t: f64, name: &str) -> f64 {
    match name {
        "hold" => {
            if t >= 1.0 {
                1.0
            } else {
                0.0
            }
        }
        "easeIn" => t.powi(3),
        "easeOut" => 1.0 - (1.0 - t).powi(3),
        "easeInOut" => {
            if t < 0.5 {
                4.0 * t.powi(3)
            } else {
                1.0 - (-2.0 * t + 2.0).powi(3) / 2.0
            }
        }
        "spring" => {
            if t == 0.0 || t == 1.0 {
                t
            } else {
                1.0 - (-7.0 * t).exp() * (12.0 * t).cos()
            }
        }
        _ => t,
    }
}
fn bezier(t: f64, control: &Value) -> Result<f64, String> {
    let default = json!([0.25, 0.1, 0.25, 1.0]);
    let values = if control.is_null() { &default } else { control };
    let points = values
        .as_array()
        .filter(|p| p.len() == 4)
        .ok_or("Invalid Bezier control points")?;
    let mut c = [0.0; 4];
    for (i, p) in points.iter().enumerate() {
        c[i] = p.as_f64().ok_or("Invalid Bezier control point")?;
    }
    if !(0.0..=1.0).contains(&c[0]) || !(0.0..=1.0).contains(&c[2]) {
        return Err("Bezier time controls must be within 0..1".into());
    }
    let curve = |q: f64, a: f64, b: f64| {
        3.0 * (1.0 - q).powi(2) * q * a + 3.0 * (1.0 - q) * q * q * b + q * q * q
    };
    let (mut low, mut high) = (0.0, 1.0);
    for _ in 0..32 {
        let mid = (low + high) / 2.0;
        if curve(mid, c[0], c[2]) < t {
            low = mid;
        } else {
            high = mid;
        }
    }
    Ok(if t <= 0.0 {
        0.0
    } else if t >= 1.0 {
        1.0
    } else {
        curve((low + high) / 2.0, c[1], c[3])
    })
}
fn set_numeric_path(node: &mut Value, property: &str, value: f64) -> Result<(), String> {
    let mut current = node;
    for part in property.split('.') {
        if ["__proto__", "constructor", "prototype"].contains(&part) {
            return Err("Invalid animation property".into());
        }
        current = if current.is_array() {
            let index = part
                .parse::<usize>()
                .map_err(|_| "Invalid animation index")?;
            current
                .as_array_mut()
                .and_then(|a| a.get_mut(index))
                .ok_or("Animation index out of range")?
        } else {
            current
                .as_object_mut()
                .and_then(|o| o.get_mut(part))
                .ok_or("Missing animation property")?
        };
    }
    if !current.is_number() {
        return Err("Animation target is not numeric".into());
    }
    *current = json!(value);
    Ok(())
}
fn interpolate(keys: &[Value], frame: f64) -> Result<f64, String> {
    if keys.is_empty() {
        return Err("Keyframes cannot be empty".into());
    }
    let mut sorted = keys.to_vec();
    sorted.sort_by(|a, b| {
        a["frame"]
            .as_f64()
            .unwrap_or(0.0)
            .total_cmp(&b["frame"].as_f64().unwrap_or(0.0))
    });
    let number = |key: &Value, field: &str| {
        key[field]
            .as_f64()
            .ok_or_else(|| format!("Invalid keyframe {field}"))
    };
    if frame <= number(&sorted[0], "frame")? {
        return number(&sorted[0], "value");
    }
    for pair in sorted.windows(2) {
        let a = &pair[0];
        let b = &pair[1];
        let begin = number(a, "frame")?;
        let end = number(b, "frame")?;
        if end <= begin {
            return Err("Duplicate keyframe times".into());
        }
        if frame < end {
            let t = (frame - begin) / (end - begin);
            let av = number(a, "value")?;
            let name = a["easing"].as_str().unwrap_or("linear");
            let amount = if name == "bezier" {
                bezier(t, &a["bezier"])?
            } else {
                easing(t, name)
            };
            return Ok(av + (number(b, "value")? - av) * amount);
        }
    }
    number(sorted.last().unwrap(), "value")
}
fn handle(request: &Value) -> Result<Value, String> {
    match request["method"].as_str().unwrap_or("") {
        "raster3d" => raster::handle(request),
        "evaluate" => {
            let frame = request["frame"]
                .as_f64()
                .filter(|f| f.is_finite() && *f >= 0.0)
                .ok_or("Invalid frame")?;
            let nodes = request["nodes"].as_array().ok_or("Expected nodes")?;
            if nodes.len() > 10_000 {
                return Err("Node limit exceeded".into());
            }
            let mut result = nodes.clone();
            for node in &mut result {
                if let Some(animations) = node["animations"].as_array().cloned() {
                    for animation in animations {
                        let property = animation["property"].as_str().ok_or("Missing property")?;
                        let keys = animation["keys"].as_array().ok_or("Missing keys")?;
                        let value = interpolate(keys, frame)?;
                        set_numeric_path(
                            node,
                            property,
                            if property == "opacity" || property == "reveal" {
                                value.clamp(0.0, 1.0)
                            } else {
                                value
                            },
                        )?;
                    }
                }
            }
            Ok(json!(result))
        }
        "sample" => {
            let frame = request["frame"].as_u64().ok_or("Invalid frame")? as u128;
            let numerator = request["num"]
                .as_u64()
                .filter(|n| *n > 0)
                .ok_or("Invalid FPS numerator")? as u128;
            let denominator = request["den"]
                .as_u64()
                .filter(|n| *n > 0)
                .ok_or("Invalid FPS denominator")? as u128;
            let sample_rate = request["sampleRate"].as_u64().unwrap_or(48_000) as u128;
            let sample = frame
                .checked_mul(denominator)
                .and_then(|n| n.checked_mul(sample_rate))
                .ok_or("Timestamp overflow")?
                / numerator;
            Ok(json!({"sample":u64::try_from(sample).map_err(|_|"Timestamp overflow")?}))
        }
        "capabilities" => Ok(
            json!({"version":"0.5.0","animation":"native-rust","indexedAnimation":1,"animationLayers":1,"rationalTime":true,"depthRaster3D":true,"rasterSamples":[1,4],"materialShading":1}),
        ),
        _ => Err("Unknown method".into()),
    }
}
fn main() {
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout());
    let mut animation_engine = animation::Engine::default();
    for line in stdin.lock().lines() {
        let output = match line {
            Ok(line) if line.len() <= 16 * 1024 * 1024 => {
                match serde_json::from_str::<Value>(&line) {
                    Ok(request) => match if request["method"] == "evaluateIndexed" {
                        animation_engine.handle(&request)
                    } else {
                        handle(&request)
                    } {
                        Ok(result) => json!({"id":request["id"],"result":result}),
                        Err(error) => json!({"id":request["id"],"error":error}),
                    },
                    Err(error) => json!({"error":error.to_string()}),
                }
            }
            _ => json!({"error":"Input limit exceeded"}),
        };
        if writeln!(stdout, "{output}")
            .and_then(|_| stdout.flush())
            .is_err()
        {
            break;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn random_access_does_not_depend_on_order() {
        let keys = json!([{"frame":0,"value":0,"easing":"easeInOut"},{"frame":60,"value":100}]);
        assert_eq!(interpolate(keys.as_array().unwrap(), 30.0).unwrap(), 50.0);
        assert_eq!(interpolate(keys.as_array().unwrap(), 0.0).unwrap(), 0.0);
        assert_eq!(interpolate(keys.as_array().unwrap(), 60.0).unwrap(), 100.0);
    }
    #[test]
    fn long_fractional_fps_audio_is_exact() {
        let request =
            json!({"method":"sample","frame":215784,"num":30000,"den":1001,"sampleRate":48000});
        assert_eq!(handle(&request).unwrap()["sample"], json!(345599654_u64));
    }
    #[test]
    fn malformed_time_is_rejected() {
        assert!(handle(&json!({"method":"sample","frame":1,"num":0,"den":1})).is_err());
    }
    #[test]
    fn evaluates_nested_controls_without_adding_a_flat_property() {
        let request = json!({"method":"evaluate","frame":30,"nodes":[{"params":{"amplitude":10},"animations":[{"property":"params.amplitude","keys":[{"frame":0,"value":10},{"frame":60,"value":20}]}]}]});
        let output = handle(&request).unwrap();
        assert_eq!(output[0]["params"]["amplitude"], 15.0);
        assert!(output[0].get("params.amplitude").is_none());
    }
    #[test]
    fn bezier_time_curve_is_inverted() {
        let keys = json!([{"frame":0,"value":0,"easing":"bezier","bezier":[0.42,0.0,0.58,1.0]},{"frame":60,"value":100}]);
        assert!((interpolate(keys.as_array().unwrap(), 30.0).unwrap() - 50.0).abs() < 1e-6);
        assert!(interpolate(keys.as_array().unwrap(), 15.0).unwrap() < 25.0);
    }
}
