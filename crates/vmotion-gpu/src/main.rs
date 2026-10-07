use serde_json::{Value, json};
use std::io::{self, Read, Write};
use std::time::Instant;
use wgpu::util::DeviceExt;
const MAX_PIXELS: usize = 3840 * 2160;
const MAX_HEADER: usize = 512 * 1024;
struct Surfaces {
    bytes: u64,
    input: wgpu::Buffer,
    output: wgpu::Buffer,
    readback: wgpu::Buffer,
    group: wgpu::BindGroup,
    flags: wgpu::Buffer,
}
struct Gpu {
    custom_pipelines: Vec<(String,wgpu::ComputePipeline)>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::ComputePipeline,
    operations: wgpu::Buffer,
    dimensions: wgpu::Buffer,
    lut: wgpu::Buffer,
    surfaces: Option<Surfaces>,
    adapter: Value,
    allocations: u64,
}
impl Gpu {
    fn new(lut: &[u8]) -> Result<Self, String> {
        if lut.len() != 65536 {
            return Err("GPU_PROTOCOL: expected 65536-byte canvas table".into());
        }
        let backends = if cfg!(target_os = "windows") {
            wgpu::Backends::DX12
        } else {
            wgpu::Backends::VULKAN | wgpu::Backends::METAL
        };
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends,
            ..Default::default()
        });
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            compatible_surface: None,
        }))
        .ok_or("GPU_UNAVAILABLE: no hardware adapter")?;
        let info = adapter.get_info();
        if !matches!(
            info.device_type,
            wgpu::DeviceType::DiscreteGpu | wgpu::DeviceType::IntegratedGpu
        ) {
            return Err("GPU_UNAVAILABLE: software/virtual adapter rejected".into());
        }
        let identity = json!({"name":info.name,"vendor":info.vendor,"device":info.device,"driver":info.driver,"driverInfo":info.driver_info,"backend":format!("{:?}",info.backend),"deviceType":format!("{:?}",info.device_type),"hardware":true});
        let mut limits = wgpu::Limits::downlevel_defaults().using_resolution(adapter.limits());
        limits.max_storage_buffers_per_shader_stage = 5;
        let (device, queue) = pollster::block_on(adapter.request_device(
            &wgpu::DeviceDescriptor {
                label: Some("Vmotion point effects"),
                required_features: wgpu::Features::empty(),
                required_limits: limits,
            },
            None,
        ))
        .map_err(|e| format!("GPU_UNAVAILABLE: {e}"))?;
        device.push_error_scope(wgpu::ErrorFilter::Validation);
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Vmotion fused SDR points"),
            source: wgpu::ShaderSource::Wgsl(include_str!("point.wgsl").into()),
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Vmotion points"),
            layout: None,
            module: &shader,
            entry_point: "main",
        });
        if let Some(error) = pollster::block_on(device.pop_error_scope()) {
            return Err(format!("GPU_SHADER: {error}"));
        }
        let operations = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("operations"),
            size: 64 * 32 * 4,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let dimensions = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("dimensions"),
            size: 16,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let lut = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("host Skia quantization"),
            contents: lut,
            usage: wgpu::BufferUsages::STORAGE,
        });
        Ok(Self {
            custom_pipelines:Vec::new(),
            device,
            queue,
            pipeline,
            operations,
            dimensions,
            lut,
            surfaces: None,
            adapter: identity,
            allocations: 0,
        })
    }
    fn run(
        &mut self,
        width: usize,
        height: usize,
        operations: &[f32],
        pixels: &[u8],
    ) -> Result<(Value, Vec<u8>), String> {
        let started = Instant::now();
        let bytes = pixels.len() as u64;
        if self.surfaces.as_ref().is_none_or(|s| s.bytes < bytes) {
            let buffer = |label, usage| {
                self.device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some(label),
                    size: bytes,
                    usage,
                    mapped_at_creation: false,
                })
            };
            let input = buffer(
                "source",
                wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            );
            let output = buffer(
                "output",
                wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST,
            );
            let flag_bytes = ((bytes / 4).div_ceil(32)) * 4;
            let flags = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("precision flags"),
                size: flag_bytes,
                usage: wgpu::BufferUsages::STORAGE
                    | wgpu::BufferUsages::COPY_SRC
                    | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            let readback = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("readback"),
                size: bytes + flag_bytes,
                usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("point surfaces"),
                layout: &self.pipeline.get_bind_group_layout(0),
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: input.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: output.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: self.operations.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: self.lut.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 4,
                        resource: self.dimensions.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 5,
                        resource: flags.as_entire_binding(),
                    },
                ],
            });
            self.surfaces = Some(Surfaces {
                bytes,
                input,
                output,
                readback,
                group,
                flags,
            });
            self.allocations += 1;
        }
        let surfaces = self.surfaces.as_ref().unwrap();
        self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        self.queue.write_buffer(&surfaces.input, 0, pixels);
        self.queue
            .write_buffer(&self.operations, 0, bytemuck::cast_slice(operations));
        self.queue.write_buffer(
            &self.dimensions,
            0,
            bytemuck::cast_slice(&[
                (width * height) as u32,
                (operations.len() / 32) as u32,
                0,
                0,
            ]),
        );
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Vmotion point execution"),
            });
        encoder.clear_buffer(&surfaces.flags, 0, None);
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("fused points"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &surfaces.group, &[]);
            pass.dispatch_workgroups(((width * height) as u32).div_ceil(256), 1, 1);
        }
        encoder.copy_buffer_to_buffer(&surfaces.output, 0, &surfaces.readback, 0, bytes);
        let flag_bytes = ((bytes / 4).div_ceil(32)) * 4;
        encoder.copy_buffer_to_buffer(&surfaces.flags, 0, &surfaces.readback, bytes, flag_bytes);
        self.queue.submit(Some(encoder.finish()));
        let slice = surfaces.readback.slice(..bytes + flag_bytes);
        let (send, receive) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = send.send(result);
        });
        self.device.poll(wgpu::Maintain::Wait);
        receive
            .recv()
            .map_err(|e| format!("GPU_READBACK: {e}"))?
            .map_err(|e| format!("GPU_READBACK: {e}"))?;
        let result = slice.get_mapped_range().to_vec();
        surfaces.readback.unmap();
        if let Some(error) = pollster::block_on(self.device.pop_error_scope()) {
            return Err(format!("GPU_EXECUTION: {error}"));
        }
        Ok((
            json!({"pixels":width*height,"stages":operations.len()/32,"dispatches":1,"uploadedBytes":bytes+operations.len() as u64*4+16,"downloadedBytes":bytes+flag_bytes,"retainedBytes":surfaces.bytes*3+((surfaces.bytes/4).div_ceil(32))*8+65536+64*32*4+16,"surfaceAllocations":self.allocations,"elapsedMs":started.elapsed().as_secs_f64()*1000.0,"timing":"host submission, GPU completion and readback wall time; not GPU timestamp"}),
            result,
        ))
    }
}
fn validate(request: &Value, payload: &[u8]) -> Result<(usize, usize, Vec<f32>), String> {
    let size = |key: &str, max: usize| {
        request[key]
            .as_u64()
            .filter(|v| *v > 0 && *v <= max as u64)
            .map(|v| v as usize)
            .ok_or_else(|| format!("GPU_DIMENSIONS: invalid {key}"))
    };
    let width = size("width", 3840)?;
    let height = size("height", 2160)?;
    if payload.len() != width * height * 4 {
        return Err("GPU_PROTOCOL: RGBA byte length differs from dimensions".into());
    }
    let raw = request["operations"]
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= 64)
        .ok_or("GPU_OPERATIONS: expected 1–64 point stages")?;
    if width * height * raw.len() > 256 * 1024 * 1024 {
        return Err("GPU_BUDGET: exceeds 256M stage pixels".into());
    }
    let mut values = Vec::with_capacity(raw.len() * 32);
    for stage in raw {
        let stage = stage
            .as_array()
            .filter(|v| v.len() == 32)
            .ok_or("GPU_OPERATIONS: expected 32 controls per stage")?;
        let mut controls = [0.0f32; 32];
        for (i, value) in stage.iter().enumerate() {
            controls[i] = value
                .as_f64()
                .map(|v| v as f32)
                .filter(|v| v.is_finite())
                .ok_or("GPU_OPERATIONS: controls must fit finite f32")?;
        }
        if ![0.0, 1.0, 2.0].contains(&controls[0]) {
            return Err("GPU_OPERATIONS: unknown kernel".into());
        }
        if controls[0] == 0.0 && ![0.0, 1.0].contains(&controls[1]) {
            return Err("GPU_OPERATIONS: invalid color space".into());
        }
        if controls[0] == 1.0
            && (![0.0, 1.0].contains(&controls[1])
                || ![0.0, 1.0, 2.0].contains(&controls[8])
                || !(0.0..=1.0).contains(&controls[4])
                || !(0.0..=1.0).contains(&controls[5])
                || !(0.0..=1.0).contains(&controls[9])
                || ![0.0, 1.0].contains(&controls[6])
                || ![0.0, 1.0].contains(&controls[7]))
        {
            return Err("GPU_OPERATIONS: invalid keyer controls".into());
        }
        if controls[0] == 2.0 {
            for i in [1, 3, 5, 7] {
                if ![-1.0, 0.0, 1.0, 2.0, 3.0, 4.0].contains(&controls[i])
                    || !(0.0..=1.0).contains(&controls[i + 1])
                {
                    return Err("GPU_OPERATIONS: invalid channel controls".into());
                }
            }
        }
        values.extend(controls);
    }
    Ok((width, height, values))
}
fn serve() -> io::Result<()> {
    let mut input = io::stdin().lock();
    let mut output = io::BufWriter::new(io::stdout().lock());
    let mut gpu: Option<Gpu> = None;
    loop {
        let mut prefix = [0u8; 8];
        match input.read_exact(&mut prefix) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(e),
        };
        let header_len = u32::from_le_bytes(prefix[..4].try_into().unwrap()) as usize;
        let payload_len = u32::from_le_bytes(prefix[4..].try_into().unwrap()) as usize;
        if header_len == 0 || header_len > MAX_HEADER || payload_len > MAX_PIXELS * 4 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "GPU frame limit",
            ));
        }
        let mut header = vec![0u8; header_len];
        let mut payload = vec![0u8; payload_len];
        input.read_exact(&mut header)?;
        input.read_exact(&mut payload)?;
        let request = serde_json::from_slice::<Value>(&header).unwrap_or(Value::Null);
        let result=match request["method"].as_str(){
            Some("initialize")=>Gpu::new(&payload).map(|instance|{let info=json!({"version":1,"adapter":instance.adapter,"scope":"point-effects","fullSceneGpu":false});gpu=Some(instance);(info,Vec::new())}),
            Some("customShader")=>gpu.as_mut().ok_or_else(||"GPU_NOT_INITIALIZED: initialize first".to_string()).and_then(|gpu|gpu.custom(&request,&payload)),
            Some("pointChain")=>validate(&request,&payload).and_then(|(w,h,ops)|gpu.as_mut().ok_or("GPU_NOT_INITIALIZED: initialize first")?.run(w,h,&ops,&payload)),
            _=>Err("GPU_PROTOCOL: unknown method".into()),
        };
        let (header, body) = match result {
            Ok((result, body)) => (json!({"id":request["id"],"result":result}), body),
            Err(error) => (json!({"id":request["id"],"error":error}), Vec::new()),
        };
        let header = serde_json::to_vec(&header)?;
        output.write_all(&(header.len() as u32).to_le_bytes())?;
        output.write_all(&(body.len() as u32).to_le_bytes())?;
        output.write_all(&header)?;
        output.write_all(&body)?;
        output.flush()?;
    }
    Ok(())
}
fn main() {
    if let Err(error) = serve() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_protocol_rejects_bad_shapes_controls_and_work() {
        let matrix = vec![0.0f32; 32];
        let valid = json!({"width":4,"height":4,"operations":[matrix]});
        assert!(validate(&valid, &[0u8; 64]).is_ok());
        for invalid in [
            json!({"width":0,"height":4,"operations":[vec![0.0;32]]}),
            json!({"width":4,"height":4,"operations":[vec![3.0;32]]}),
            json!({"width":4,"height":4,"operations":[vec![0.0;31]]}),
            json!({"width":3840,"height":2160,"operations":vec![vec![0.0;32];64]}),
        ] {
            assert!(validate(&invalid, &[0u8; 64]).is_err());
        }
    }
}

impl Gpu {
    fn custom(&mut self, request: &Value, pixels: &[u8]) -> Result<(Value, Vec<u8>), String> {
        let width=request["width"].as_u64().filter(|v|*v>0&&*v<=3840).ok_or("PROGRAM_DIMENSIONS: width")? as usize;
        let height=request["height"].as_u64().filter(|v|*v>0&&*v<=2160).ok_or("PROGRAM_DIMENSIONS: height")? as usize;
        if pixels.len()!=width*height*4 {return Err("PROGRAM_PROTOCOL: RGBA size".into());}
        let source=request["shader"].as_str().filter(|s|!s.is_empty()&&s.len()<=131072).ok_or("PROGRAM_SHADER: source budget")?;
        let controls=request["uniforms"].as_array().filter(|u|u.len()==72).ok_or("PROGRAM_SHADER: uniforms")?;
        let uniforms=controls.iter().map(|u|u.as_f64().filter(|v|v.is_finite()&&(*v as f32).is_finite()).map(|v|v as f32).ok_or("PROGRAM_SHADER: finite uniforms")).collect::<Result<Vec<_>,_>>()?;
        let workgroup=request["workgroup"].as_array().filter(|w|w.len()==2).ok_or("PROGRAM_SHADER: workgroup")?;
        let wx=workgroup[0].as_u64().filter(|v|*v>0&&*v<=256).ok_or("PROGRAM_SHADER: workgroup x")? as u32;
        let wy=workgroup[1].as_u64().filter(|v|*v>0&&*v<=256).ok_or("PROGRAM_SHADER: workgroup y")? as u32;
        if wx*wy>256{return Err("PROGRAM_SHADER: workgroup budget".into());}
        let started=Instant::now();
        if !self.custom_pipelines.iter().any(|(text,_)|text==source) {
            self.device.push_error_scope(wgpu::ErrorFilter::Validation);
            let shader=self.device.create_shader_module(wgpu::ShaderModuleDescriptor{label:Some("project WGSL"),source:wgpu::ShaderSource::Wgsl(source.into())});
            let bindings=self.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor{label:Some("project RGBA contract"),entries:&[
                wgpu::BindGroupLayoutEntry{binding:0,visibility:wgpu::ShaderStages::COMPUTE,ty:wgpu::BindingType::Buffer{ty:wgpu::BufferBindingType::Storage{read_only:true},has_dynamic_offset:false,min_binding_size:None},count:None},
                wgpu::BindGroupLayoutEntry{binding:1,visibility:wgpu::ShaderStages::COMPUTE,ty:wgpu::BindingType::Buffer{ty:wgpu::BufferBindingType::Storage{read_only:false},has_dynamic_offset:false,min_binding_size:None},count:None},
                wgpu::BindGroupLayoutEntry{binding:2,visibility:wgpu::ShaderStages::COMPUTE,ty:wgpu::BindingType::Buffer{ty:wgpu::BufferBindingType::Storage{read_only:true},has_dynamic_offset:false,min_binding_size:None},count:None},
            ]});
            let layout=self.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor{label:Some("project shader contract"),bind_group_layouts:&[&bindings],push_constant_ranges:&[]});
            let pipeline=self.device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor{label:Some("project main"),layout:Some(&layout),module:&shader,entry_point:"main"});
            if let Some(error)=pollster::block_on(self.device.pop_error_scope()){return Err(format!("PROGRAM_SHADER: {error}"));}
            if self.custom_pipelines.len()>=16{self.custom_pipelines.remove(0);}
            self.custom_pipelines.push((source.into(),pipeline));
        }
        let bytes=pixels.len() as u64;
        if self.surfaces.as_ref().is_none_or(|surface|surface.bytes<bytes){
            // Existing bounded surfaces and transfer code provide allocation/precision ownership.
            self.run(width,height,&[0.0;32],pixels)?;
        }
        let surface=self.surfaces.as_ref().unwrap();
        let pipeline=&self.custom_pipelines.iter().find(|(text,_)|text==source).unwrap().1;
        self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let group=self.device.create_bind_group(&wgpu::BindGroupDescriptor{label:Some("project inputs"),layout:&pipeline.get_bind_group_layout(0),entries:&[
            wgpu::BindGroupEntry{binding:0,resource:wgpu::BindingResource::Buffer(wgpu::BufferBinding{buffer:&surface.input,offset:0,size:std::num::NonZeroU64::new(bytes)})},
            wgpu::BindGroupEntry{binding:1,resource:wgpu::BindingResource::Buffer(wgpu::BufferBinding{buffer:&surface.output,offset:0,size:std::num::NonZeroU64::new(bytes)})},
            wgpu::BindGroupEntry{binding:2,resource:wgpu::BindingResource::Buffer(wgpu::BufferBinding{buffer:&self.operations,offset:0,size:std::num::NonZeroU64::new(72*4)})},
        ]});
        self.queue.write_buffer(&surface.input,0,pixels);
        self.queue.write_buffer(&self.operations,0,bytemuck::cast_slice(&uniforms));
        let mut encoder=self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor{label:Some("project WGSL frame")});
        encoder.clear_buffer(&surface.output,0,None);
        {let mut pass=encoder.begin_compute_pass(&wgpu::ComputePassDescriptor{label:Some("project WGSL"),timestamp_writes:None});pass.set_pipeline(pipeline);pass.set_bind_group(0,&group,&[]);pass.dispatch_workgroups((width as u32).div_ceil(wx),(height as u32).div_ceil(wy),1);}
        encoder.copy_buffer_to_buffer(&surface.output,0,&surface.readback,0,bytes);
        self.queue.submit(Some(encoder.finish()));
        let slice=surface.readback.slice(..bytes);let(send,receive)=std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read,move|result|{let _=send.send(result);});self.device.poll(wgpu::Maintain::Wait);
        receive.recv().map_err(|e|e.to_string())?.map_err(|e|e.to_string())?;
        let result=slice.get_mapped_range().to_vec();surface.readback.unmap();
        if let Some(error)=pollster::block_on(self.device.pop_error_scope()){return Err(format!("PROGRAM_SHADER: {error}"));}
        Ok((json!({"width":width,"height":height,"pipelines":self.custom_pipelines.len(),"surfaceAllocations":self.allocations,"bytes":bytes,"elapsedMs":started.elapsed().as_secs_f64()*1000.0}),result))
    }
}
