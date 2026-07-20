import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'

// ===== 常量 =====
const Y_OFFSET = 9
const CAR_SPEED = 6
const BATTERY_DRAIN_RATE = 1/3           // %/秒（约3秒1%）
const BATTERY_CHARGE_RATE = 5          // %/秒
const FEED_TIME = 10                   // 停留秒数
let LOW_BATTERY_THRESHOLD = 10           // % (可从面板调节)
let LOW_FEED_THRESHOLD = 5               // kg (余粮低于此值去补料)
let LOW_FEED_LOWBATT_THRESHOLD = 10      // kg (低电量时余粮低于此值先去补料再充电)
const REFILL_SPEED = 5                 // kg/秒

// ===== 场景 =====
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x87ceeb)
scene.fog = new THREE.Fog(0x87ceeb, 200, 500)

// 天空颜色关键帧（秒 → 颜色）
const SKY_KF = [
  { t: 0,      r: 10/255,  g: 10/255,  b: 46/255  },  // 00:00 暗蓝色
  { t: 4*3600, r: 15/255,  g: 82/255,  b: 186/255 },  // 04:00 宝石蓝
  { t: 6*3600, r: 135/255, g: 206/255, b: 235/255 },  // 06:00 天蓝色
  { t: 16*3600,r: 135/255, g: 206/255, b: 235/255 },  // 16:00 天蓝色
  { t: 18*3600,r: 255/255, g: 200/255, b: 150/255 },  // 18:00 淡橘色
  { t: 20*3600,r: 255/255, g: 165/255, b:   0/255 },  // 20:00 橘色
  { t: 24*3600,r: 10/255,  g: 10/255,  b: 46/255  },  // 24:00 暗蓝色
]

function lerpKF(kf, simT) {
  const dayT = ((simT % (24 * 3600)) + 24 * 3600) % (24 * 3600)
  for (let i = 0; i < kf.length - 1; i++) {
    if (dayT >= kf[i].t && dayT <= kf[i+1].t) {
      const t = (dayT - kf[i].t) / (kf[i+1].t - kf[i].t)
      return {
        r: kf[i].r + (kf[i+1].r - kf[i].r) * t,
        g: kf[i].g + (kf[i+1].g - kf[i].g) * t,
        b: kf[i].b + (kf[i+1].b - kf[i].b) * t,
      }
    }
  }
  return kf[kf.length - 1]
}

function updateSkyAndLighting(simT) {
  const col = lerpKF(SKY_KF, simT)
  scene.background.setRGB(col.r, col.g, col.b)
  if (scene.fog) scene.fog.color.setRGB(col.r, col.g, col.b)

  // 光照：根据时间计算强度因子 0~1（06:00~18:00 为白天）
  const dayT = ((simT % (24 * 3600)) + 24 * 3600) % (24 * 3600)
  let dayFactor
  if (dayT >= 6*3600 && dayT <= 18*3600) {
    dayFactor = 1.0  // 白天
  } else if (dayT >= 4*3600 && dayT < 6*3600) {
    dayFactor = (dayT - 4*3600) / (2*3600)  // 04→06 渐亮
  } else if (dayT > 18*3600 && dayT <= 20*3600) {
    dayFactor = 1.0 - (dayT - 18*3600) / (2*3600)  // 18→20 渐暗
  } else {
    dayFactor = 0.08  // 夜晚
  }

  // 太阳光强度与位置
  sunLight.intensity = 1.5 * dayFactor
  sunLight.color.setHSL(0.08, 0.3 * dayFactor, 0.5 + 0.3 * dayFactor)
  // 太阳位置随时间段移动（东→南→西）
  const sunAngle = ((dayT / (24*3600)) * Math.PI * 2) - Math.PI / 2
  sunLight.position.set(Math.cos(sunAngle) * 60, 20 + 60 * Math.sin(sunAngle), 30)
  sunLight.position.y = Math.max(5, sunLight.position.y)

  // 环境光
  const ambient = scene.children.find(c => c.isAmbientLight)
  if (ambient) ambient.intensity = 0.15 + 1.05 * dayFactor

  // 填充光（夜晚偏蓝冷色）
  fillLight.intensity = 0.1 + 0.3 * (1 - dayFactor)

  // 半球光强度
  const hemi = scene.children.find(c => c.isHemisphereLight)
  if (hemi) hemi.intensity = 0.2 + 0.8 * dayFactor

  // 室内灯光：夜晚全亮，白天调暗
  const indoorLights = scene.children.filter(c => c.isPointLight)
  indoorLights.forEach(l => { l.intensity = 1.0 + (1 - dayFactor) * 1.5 })
}

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000)
camera.position.set(60, 50 + Y_OFFSET, 80)

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFShadowMap
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.2
document.body.appendChild(renderer.domElement)

const labelRenderer = new CSS2DRenderer()
labelRenderer.setSize(window.innerWidth, window.innerHeight)
labelRenderer.domElement.style.position = 'absolute'
labelRenderer.domElement.style.top = '0px'
labelRenderer.domElement.style.left = '0px'
labelRenderer.domElement.style.pointerEvents = 'none'
document.body.appendChild(labelRenderer.domElement)

// ===== 键盘控制 =====
const keys = { w: false, a: false, s: false, d: false, q: false, e: false, shift: false }
document.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase()
  if (k === 'shift') { keys.shift = true; return }
  if (k in keys) { keys[k] = true; e.preventDefault() }
})
document.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase()
  if (k === 'shift') { keys.shift = false; return }
  if (k in keys) { keys[k] = false; e.preventDefault() }
})

const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, Y_OFFSET, 0)
controls.enableDamping = true
controls.dampingFactor = 0.1
controls.maxPolarAngle = Math.PI / 2.1
controls.update()

// ===== 光照 =====
scene.add(new THREE.AmbientLight(0xffffff, 1.2))

const sunLight = new THREE.DirectionalLight(0xffeedd, 1.5)
sunLight.position.set(50, 80, 30)
sunLight.castShadow = true
sunLight.shadow.mapSize.width = 2048
sunLight.shadow.mapSize.height = 2048
sunLight.shadow.camera.near = 0.5; sunLight.shadow.camera.far = 200
sunLight.shadow.camera.left = -80; sunLight.shadow.camera.right = 80
sunLight.shadow.camera.top = 80; sunLight.shadow.camera.bottom = -80
scene.add(sunLight)

const fillLight = new THREE.DirectionalLight(0x8888ff, 0.4)
fillLight.position.set(-30, 20, -50)
scene.add(fillLight)
scene.add(new THREE.HemisphereLight(0x87ceeb, 0x3a7d44, 1.0))

// 大棚内部光源
const indoorPos = [[-20,12,-20],[20,12,-20],[-20,12,20],[20,12,20],[0,12,0],[-20,12,0],[20,12,0],[0,12,-20],[0,12,20]]
indoorPos.forEach(([x,y,z]) => {
  const light = new THREE.PointLight(0xfff0dd, 2.0, 50)
  light.position.set(x, y + Y_OFFSET, z)
  scene.add(light)
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.3,8,8), new THREE.MeshBasicMaterial({color:0xffeecc,transparent:true,opacity:0.8}))
  bulb.position.set(x, y + Y_OFFSET, z)
  scene.add(bulb)
})

// ===== 地面 =====
const ground = new THREE.Mesh(new THREE.PlaneGeometry(200,200), new THREE.MeshStandardMaterial({color:0x5a8f4a,roughness:0.8}))
ground.rotation.x = -Math.PI/2; ground.position.y = -0.1 + Y_OFFSET; ground.receiveShadow = true
scene.add(ground)

// ===== 大棚 =====
const GW=140, GD=150, GH=22, GX=0, GZ=0, GY=Y_OFFSET

const floorBig = new THREE.Mesh(new THREE.PlaneGeometry(GW,GD), new THREE.MeshStandardMaterial({
  color:0x999999,roughness:0.9,metalness:0.1,transparent:true,opacity:0.4
}))
floorBig.rotation.x = -Math.PI/2; floorBig.position.set(GX, GY+0.01, GZ); floorBig.receiveShadow = true
scene.add(floorBig)

const glassMat = new THREE.MeshPhysicalMaterial({color:0x88ccff,transparent:true,opacity:0.15,roughness:0.0,metalness:0.0,side:THREE.DoubleSide,depthWrite:false})
const wd = [{w:GW,h:GH,x:GX,z:GZ-GD/2,ry:0},{w:GW,h:GH,x:GX,z:GZ+GD/2,ry:0},{w:GD,h:GH,x:GX-GW/2,z:GZ,ry:Math.PI/2},{w:GD,h:GH,x:GX+GW/2,z:GZ,ry:Math.PI/2}]
wd.forEach(({w,h,x,z,ry})=>{const m=new THREE.Mesh(new THREE.PlaneGeometry(w,h),glassMat);m.position.set(x,GY+h/2,z);m.rotation.y=ry;scene.add(m)})

const pillarMat = new THREE.MeshStandardMaterial({color:0xcccccc,roughness:0.6,metalness:0.2})
const pp = [[GX-GW/2,GZ-GD/2],[GX+GW/2,GZ-GD/2],[GX-GW/2,GZ+GD/2],[GX+GW/2,GZ+GD/2],[GX-GW/2,GZ],[GX+GW/2,GZ],[GX,GZ-GD/2],[GX,GZ+GD/2]]
pp.forEach(([px,pz])=>{const p=new THREE.Mesh(new THREE.BoxGeometry(0.4,GH,0.4),pillarMat);p.position.set(px,GY+GH/2,pz);p.castShadow=true;p.receiveShadow=true;scene.add(p)})

const roofMat = new THREE.MeshStandardMaterial({color:0x2a3a5a,roughness:0.5,metalness:0.6,side:THREE.DoubleSide})
for(let x=GX-GW/2+2; x<=GX+GW/2-2; x+=3){
  const p=new THREE.Mesh(new THREE.BoxGeometry(2.8,0.08,GD-1),roofMat);p.position.set(x,GY+GH,GZ);p.castShadow=true;p.receiveShadow=true;scene.add(p)
}

// 方向标识
function makeCL(text,x,z,fg,bg){
  const div=document.createElement('div');div.textContent=text;div.style.color=fg;div.style.fontSize='32px';div.style.fontWeight='bold';div.style.fontFamily='Arial,sans-serif';div.style.background=bg;div.style.padding='4px 12px';div.style.borderRadius='6px';div.style.textShadow='1px 1px 3px rgba(0,0,0,0.6)'
  const l=new CSS2DObject(div);l.position.set(x,Y_OFFSET+2,z);return l
}
const CD=6
scene.add(makeCL(' N ',0,-(GD/2+CD),'#fff','#cc3333'))
scene.add(makeCL(' S ',0,GD/2+CD,'#fff','#3333cc'))
scene.add(makeCL(' W ',-(GW/2+CD),0,'#fff','#33aa33'))
scene.add(makeCL(' E ',GW/2+CD,0,'#fff','#aa33aa'))

// ===== 鱼塘系统 =====
const TANK_COLS=4, TANK_ROWS=5, TANK_SPACING_X=30, TANK_SPACING_Z=26
const TANK_OFFSET_X=-45, TANK_OFFSET_Z=-52, TANK_SCALE=0.8, TANK_LIFT=3.0

const tankPositions = []
for(let r=0;r<TANK_ROWS;r++) for(let c=0;c<TANK_COLS;c++)
  tankPositions.push({x:TANK_OFFSET_X+c*TANK_SPACING_X, z:TANK_OFFSET_Z+r*TANK_SPACING_Z})

// 每个鱼塘的数据
const ponds = tankPositions.map((pos,i) => ({
  id: i+1, x: pos.x, z: pos.z,
  feedLevel: 0,
  fishCount: 3 + Math.floor(Math.random() * 7),
  isFeeding: false,
  waterQuality: 95,
  lastFeedTime: 0,
  lastFeedAmount: 0,
  lastQualityCheck: 0,
  qualityFeedFloor: 95,
}))

// ===== 鱼塘标签 (CSS2DRenderer) =====
const tankLabels = []
ponds.forEach(p => {
  const div = document.createElement('div')
  div.textContent = `#${p.id}`
  div.style.color = '#fff'
  div.style.fontSize = '14px'
  div.style.fontWeight = 'bold'
  div.style.background = 'rgba(0,0,0,0.6)'
  div.style.padding = '2px 8px'
  div.style.borderRadius = '12px'
  div.style.border = '1px solid rgba(255,255,255,0.3)'
  div.style.cursor = 'pointer'
  div.style.fontFamily = 'Arial,sans-serif'
  div.style.transition = 'background 0.2s'
  const label = new CSS2DObject(div)
  label.position.set(p.x, Y_OFFSET + TANK_LIFT + 2.5, p.z)
  scene.add(label)
  tankLabels.push(label)
})

// ===== 加载鱼塘模型 =====
const tankMeshes = []
const tankWaterMeshes = []  // water mesh per tank for color update
const TANK_KEEP = ['pondbase','water']
new GLTFLoader().load('/models/little_pond__fish.glb', (gltf) => {
  const src = gltf.scene
  src.position.set(tankPositions[0].x, Y_OFFSET+TANK_LIFT, tankPositions[0].z)
  src.scale.set(TANK_SCALE,TANK_SCALE,TANK_SCALE)
  src.traverse(c=>{if(c.isMesh){if(!TANK_KEEP.some(k=>c.name.includes(k))){c.visible=false;return}c.castShadow=true;c.receiveShadow=true;c.frustumCulled=false;if(c.name.includes('water'))tankWaterMeshes[0]=c}})
  scene.add(src); tankMeshes.push(src)
  for(let i=1;i<tankPositions.length;i++){
    const cl=src.clone();cl.position.set(tankPositions[i].x,Y_OFFSET+TANK_LIFT,tankPositions[i].z)
    cl.traverse(c=>{if(c.isMesh){if(!TANK_KEEP.some(k=>c.name.includes(k))){c.visible=false;return}c.castShadow=true;c.receiveShadow=true;c.frustumCulled=false;if(c.name.includes('water'))tankWaterMeshes[i]=c}})
    scene.add(cl); tankMeshes.push(cl)
  }
  loadFishIntoTanks()
})

// ===== 鱼 =====
const FISH_SCALE=0.4, FISH_RADIUS=4.5
const fishData = []  // { mesh, mixer, pondId, baseX, baseZ, targetX, targetZ, moveTimer, speedMul }

function loadFishIntoTanks(){
  const jobs=[]; let clip=null
  ponds.forEach(p=>{for(let i=0;i<p.fishCount;i++){const a=Math.random()*Math.PI*2,d=Math.random()*FISH_RADIUS;jobs.push({x:p.x+Math.cos(a)*d,y:Y_OFFSET+TANK_LIFT+0.3,z:p.z+Math.sin(a)*d,ry:Math.random()*Math.PI*2,pondId:p.id})}})
  let idx=0
  function next(){
    if(idx>=jobs.length)return
    const j=jobs[idx++]
    new GLTFLoader().load('/models/fish.glb',gltf=>{if(!clip)clip=gltf.animations[0]
      const f=gltf.scene;f.position.set(j.x,j.y,j.z);f.scale.set(FISH_SCALE,FISH_SCALE,FISH_SCALE);f.rotation.y=j.ry
      f.traverse(c=>{if(c.isMesh){c.castShadow=true;c.receiveShadow=true;c.frustumCulled=false}})
      scene.add(f)
      const mx=new THREE.AnimationMixer(f);mx.clipAction(clip).play()
      fishData.push({
        mesh: f, mixer: mx, pondId: j.pondId,
        baseX: j.x, baseZ: j.z,
        targetX: j.x, targetZ: j.z,
        moveTimer: Math.random() * 3,
        speedMul: 0.3 + Math.random() * 0.4,
      })
      next()
    })
  }
  for(let i=0;i<6;i++)next()
}

// 鱼塘抢食动画
function updateFish(dt) {
  for (const fish of fishData) {
    fish.mixer.update(dt)

    const pond = ponds.find(p => p.id === fish.pondId)
    if (!pond) continue

    const isFeeding = pond.isFeeding

    // 到达目标或计时到 → 选新目标点
    const dx = fish.targetX - fish.mesh.position.x
    const dz = fish.targetZ - fish.mesh.position.z
    const dist = Math.hypot(dx, dz)

    fish.moveTimer -= dt
    if (fish.moveTimer <= 0 || dist < 0.15) {
      const range = isFeeding ? FISH_RADIUS * 0.75 : FISH_RADIUS * 0.3
      const a = Math.random() * Math.PI * 2
      const d = Math.random() * range
      fish.targetX = fish.baseX + Math.cos(a) * d
      fish.targetZ = fish.baseZ + Math.sin(a) * d
      fish.moveTimer = isFeeding ? 0.3 + Math.random() * 0.8 : 2.0 + Math.random() * 3.0
    }

    // 朝目标移动
    if (dist > 0.05) {
      const speed = isFeeding ? 2.0 : 0.35
      const step = speed * fish.speedMul * Math.min(dt, 0.05)
      fish.mesh.position.x += (dx / dist) * step
      fish.mesh.position.z += (dz / dist) * step

      // 平滑转向
      const targetAngle = Math.atan2(dx, dz)
      let diff = targetAngle - fish.mesh.rotation.y
      while (diff > Math.PI) diff -= Math.PI * 2
      while (diff < -Math.PI) diff += Math.PI * 2
      const rotSpeed = isFeeding ? 10 : 3
      fish.mesh.rotation.y += Math.sign(diff) * Math.min(Math.abs(diff), rotSpeed * Math.min(dt, 0.05))
    }
  }
}

// ===== 碰撞箱 =====
const tankColliderData = ponds.map(p=>({x:p.x,z:p.z,radius:5}))
tankColliderData.forEach(d=>{
  const b=new THREE.Mesh(new THREE.BoxGeometry(d.radius*2,2,d.radius*2),new THREE.MeshBasicMaterial({color:0xff4444,wireframe:true,transparent:true,opacity:0.15,depthWrite:false}))
  b.position.set(d.x,Y_OFFSET+TANK_LIFT,d.z);scene.add(b)
})

// ===== 料塔 =====
const siloData = [
  { x: -63, z: 0, feed: 500 },
  { x: 63, z: 0, feed: 500 },
]
new GLTFLoader().load('/models/silo.glb', (gltf) => {
  ;[-63,63].forEach((x,i)=>{
    const s=i===0?gltf.scene:gltf.scene.clone()
    s.position.set(x,Y_OFFSET,0);s.scale.set(60,60,60)
    s.traverse(c=>{if(c.isMesh){c.castShadow=true;c.receiveShadow=true;c.frustumCulled=false}})
    scene.add(s)
  })
})

// ===== 充电桩 =====
new GLTFLoader().load('/models/charging%20station.glb', (gltf) => {
  ;[-63,63].forEach((x,i)=>{
    const cs=i===0?gltf.scene:gltf.scene.clone()
    cs.position.set(x,Y_OFFSET,18);cs.scale.set(0.2,0.2,0.2);cs.rotation.y=Math.PI/2
    cs.traverse(c=>{if(c.isMesh){c.castShadow=true;c.receiveShadow=true;c.frustumCulled=false}})
    scene.add(cs)
  })
})

// ===== 小车 =====
let carMeshes = []
const carts = [
  { id:1, x:-61, z:18, battery:100, feed:50, maxFeed:100, state:'idle', target:null, taskQueue:[], path:[], pathIndex:0, waitTimer:0, refillSiloIdx:0, totalFed:0, reversing:false, stuckTimer:0, lastDist:0 },
  { id:2, x:61, z:18, battery:100, feed:50, maxFeed:100, state:'idle', target:null, taskQueue:[], path:[], pathIndex:0, waitTimer:0, refillSiloIdx:1, totalFed:0, reversing:false, stuckTimer:0, lastDist:0 },
]

// 小车模型容器（因为 car.glb 有 SkinnedMesh，不 clone 只各自加载）
const carLoaders = [new GLTFLoader(), new GLTFLoader()]
carLoaders[0].load('/models/car.glb', (gltf) => {
  const c=gltf.scene; c.position.set(carts[0].x,Y_OFFSET,carts[0].z); c.scale.set(1,1,1); c.rotation.y=Math.PI
  c.traverse(ch=>{if(ch.isMesh){ch.castShadow=true;ch.receiveShadow=true;ch.frustumCulled=false}})
  scene.add(c); carMeshes[0]=c
})
carLoaders[1].load('/models/car.glb', (gltf) => {
  const c=gltf.scene; c.position.set(carts[1].x,Y_OFFSET,carts[1].z); c.scale.set(1,1,1); c.rotation.y=Math.PI
  c.traverse(ch=>{if(ch.isMesh){ch.castShadow=true;ch.receiveShadow=true;ch.frustumCulled=false}})
  scene.add(c); carMeshes[1]=c
})

// ===== 全局调度 =====
let nextTaskId = 1
let simTime = 8 * 3600  // 早上8点开始（秒）
let simSpeed = 1
let isRunning = false
let isPaused = false
const taskQueue = []  // 用户定义的任务 {tankId, amount, cartId:0|1|2, id, interval, lastRun}

// 添加默认任务（根据每个鱼塘的鱼数量自动分配，默认间隔6小时）
for(let i=0;i<8;i++) taskQueue.push({tankId:i+1, amount: ponds[i].fishCount * 1, cartId:0, id: nextTaskId++, interval:6, lastRun:0})

// ===== 曼哈顿网格寻路（仅上下左右，不斜走）=====
const GRID_CELL = 4
const GRID_MIN_X = -70, GRID_MIN_Z = -75
const GRID_COLS = Math.floor(140 / GRID_CELL)  // 35
const GRID_ROWS = Math.floor(150 / GRID_CELL)  // 37

function toGrid(wx, wz) {
  return { gx: Math.floor((wx - GRID_MIN_X) / GRID_CELL), gz: Math.floor((wz - GRID_MIN_Z) / GRID_CELL) }
}

function toWorld(gx, gz) {
  return { wx: GRID_MIN_X + (gx + 0.5) * GRID_CELL, wz: GRID_MIN_Z + (gz + 0.5) * GRID_CELL }
}

function isWalkable(gx, gz, extraBlocked) {
  if (gx < 0 || gx >= GRID_COLS || gz < 0 || gz >= GRID_ROWS) return false
  const { wx, wz } = toWorld(gx, gz)
  for (const ob of tankColliderData) {
    if (Math.abs(wx - ob.x) < ob.radius + 2.5 && Math.abs(wz - ob.z) < ob.radius + 2.5) return false
  }
  // 额外动态障碍（如另一辆车）
  if (extraBlocked) {
    for (const b of extraBlocked) {
      if (Math.abs(gx - b.gx) <= 1 && Math.abs(gz - b.gz) <= 1) return false
    }
  }
  return true
}

function astar(gx0, gz0, gx1, gz1, extraBlocked) {
  const key = (x, z) => x * 1000 + z
  const sk = key(gx0, gz0), ek = key(gx1, gz1)
  if (!isWalkable(gx1, gz1, extraBlocked)) return null

  const g = {}, f = {}, parent = {}
  const open = [{ x: gx0, z: gz0 }]
  g[sk] = 0; f[sk] = Math.abs(gx1 - gx0) + Math.abs(gz1 - gz0); parent[sk] = null
  const visited = new Set()
  const dirs = [[0, 1], [0, -1], [1, 0], [-1, 0]]

  while (open.length > 0) {
    let bi = 0
    for (let i = 1; i < open.length; i++) {
      if (f[key(open[i].x, open[i].z)] < f[key(open[bi].x, open[bi].z)]) bi = i
    }
    const cur = open.splice(bi, 1)[0]
    const ck = key(cur.x, cur.z)
    if (ck === ek) {
      const path = []; let k = ck
      while (k !== null) { const x = Math.floor(k / 1000), z = k % 1000; path.unshift({ gx: x, gz: z }); k = parent[k] }
      return path
    }
    visited.add(ck)
    for (const [dx, dz] of dirs) {
      const nx = cur.x + dx, nz = cur.z + dz
      if (!isWalkable(nx, nz, extraBlocked) || visited.has(key(nx, nz))) continue
      const nk = key(nx, nz); const ng = g[ck] + 1
      if (g[nk] === undefined || ng < g[nk]) {
        g[nk] = ng; f[nk] = ng + Math.abs(nx - gx1) + Math.abs(nz - gz1)
        parent[nk] = ck; open.push({ x: nx, z: nz })
      }
    }
  }
  return null
}

function findPath(fromX, fromZ, toX, toZ, extraBlocked) {
  const st = toGrid(fromX, fromZ), en = toGrid(toX, toZ)

  // 如果已经在目标格子
  if (st.gx === en.gx && st.gz === en.gz) return [{ x: toX, z: toZ }]

  // 使用 A* 寻路
  let result = astar(st.gx, st.gz, en.gx, en.gz, extraBlocked)

  // 如果目标格子不可走（比如鱼塘中心），找最近的可走格子
  if (!result || result.length <= 1) {
    let nearest = null, nearDist = Infinity
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        const nx = en.gx + dx, nz = en.gz + dz
        if (!isWalkable(nx, nz, extraBlocked)) continue
        const d = Math.abs(nx - st.gx) + Math.abs(nz - st.gz)
        if (d < nearDist) { nearDist = d; nearest = { gx: nx, gz: nz } }
      }
    }
    if (nearest) result = astar(st.gx, st.gz, nearest.gx, nearest.gz, extraBlocked)
  }

  if (!result || result.length <= 1) {
    // A* 找不到路，找起点附近可走格子
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const nx = st.gx + dx, nz = st.gz + dz
        if (isWalkable(nx, nz, extraBlocked)) {
          const { wx, wz } = toWorld(nx, nz)
          return [{ x: wx, z: wz }]
        }
      }
    }
    // 实在找不到就原地不动
    return [{ x: fromX, z: fromZ }]
  }

  const path = []
  for (let i = 1; i < result.length; i++) {
    const { wx, wz } = toWorld(result[i].gx, result[i].gz)
    path.push({ x: wx, z: wz })
  }

  // 目标位置不在碰撞箱内时才追加（防止往鱼塘中心开）
  let targetBlocked = false
  for (const ob of tankColliderData) {
    if (Math.hypot(toX - ob.x, toZ - ob.z) < ob.radius + 1) { targetBlocked = true; break }
  }
  if (!targetBlocked) {
    path.push({ x: toX, z: toZ })
  }

  return buildSmoothPath(path)
}

function isPointBlocked(x, z) {
  for (const ob of tankColliderData) {
    if (Math.hypot(x - ob.x, z - ob.z) < ob.radius + 2) return true
  }
  return false
}

// ===== 平滑路径生成（拐弯处插入弧线点）=====
function buildSmoothPath(path) {
  if (path.length <= 2) return path
  const ARC_PTS = 3, R = 2.0
  const out = [{ x: path[0].x, z: path[0].z }]

  for (let i = 1; i < path.length - 1; i++) {
    const prev = path[i-1], cur = path[i], next = path[i+1]
    const dirIn = { x: Math.sign(cur.x - prev.x) || 0, z: Math.sign(cur.z - prev.z) || 0 }
    const dirOut = { x: Math.sign(next.x - cur.x) || 0, z: Math.sign(next.z - cur.z) || 0 }

    // 不是拐弯，直接加
    if (dirIn.x === dirOut.x && dirIn.z === dirOut.z) {
      out.push({ x: cur.x, z: cur.z })
      continue
    }

    // 拐弯：生成弧线
    const segIn = Math.hypot(cur.x - prev.x, cur.z - prev.z)
    const segOut = Math.hypot(next.x - cur.x, next.z - cur.z)
    const radius = Math.min(R, segIn * 0.3, segOut * 0.3)

    // 先检查弧线范围是否会被障碍物挡住
    const arcStart = { x: cur.x - dirIn.x * radius, z: cur.z - dirIn.z * radius }
    const arcEnd = { x: cur.x + dirOut.x * radius, z: cur.z + dirOut.z * radius }

    // 弧的起点或终点已经被挡住 → 跳过平滑，直接用拐点
    if (isPointBlocked(arcStart.x, arcStart.z) || isPointBlocked(arcEnd.x, arcEnd.z)) {
      out.push({ x: cur.x, z: cur.z })
      continue
    }

    out.push(arcStart)

    // 计算弧的起始角度和结束角度
    let aStart = Math.atan2(-dirIn.z, -dirIn.x)
    let aEnd = Math.atan2(dirOut.z, dirOut.x)
    const cross = dirIn.x * dirOut.z - dirIn.z * dirOut.x
    if (cross > 0) { while (aStart < aEnd) aStart += Math.PI * 2 }
    else           { while (aEnd < aStart) aEnd += Math.PI * 2 }

    let arcOk = true
    for (let j = 1; j <= ARC_PTS; j++) {
      const t = j / (ARC_PTS + 1)
      const ang = aStart + (aEnd - aStart) * t
      const px = cur.x + radius * Math.cos(ang)
      const pz = cur.z + radius * Math.sin(ang)
      if (isPointBlocked(px, pz)) { arcOk = false; break }
      out.push({ x: px, z: pz })
    }

    if (!arcOk) {
      // 弧线被挡住，回退到拐点
      out.pop() // 移除最后一个弧线点
      out.push({ x: cur.x, z: cur.z })
      continue
    }

    if (Math.hypot(arcEnd.x - next.x, arcEnd.z - next.z) > 1) out.push(arcEnd)
  }

  out.push({ x: path[path.length-1].x, z: path[path.length-1].z })
  return out
}

// ===== 移动小车 =====
function moveCart(cart, dt) {
  if (!cart.path || cart.path.length === 0) return false
  const target = cart.path[cart.pathIndex]
  if (!target) return false

  const dx = target.x - cart.x
  const dz = target.z - cart.z
  const d = Math.hypot(dx, dz)
  const step = CAR_SPEED * dt

  // 接近当前目标点，切换到下一个
  if (d < step * 1.5) {
    cart.x = target.x
    cart.z = target.z
    cart.pathIndex++
    if (cart.pathIndex >= cart.path.length) {
      cart.path = []; cart.pathIndex = 0
      if (carMeshes[cart.id-1]) {
        carMeshes[cart.id-1].position.set(cart.x, Y_OFFSET, cart.z)
      }
      return false
    }
    return true
  }

  // 动态避障：前方路径点被另一辆车挡住时重算路径
  for (const other of carts) {
    if (other.id === cart.id) continue
    if (Math.hypot(target.x - other.x, target.z - other.z) >= 4) continue
    // 以路径最后一个点为最终目的地重算
    const lastPt = cart.path[cart.path.length - 1]
    if (!lastPt) break
    const og = toGrid(other.x, other.z)
    const newPath = findPath(cart.x, cart.z, lastPt.x, lastPt.z, [{ gx: og.gx, gz: og.gz }])
    if (newPath && newPath.length > 1) {
      cart.path = newPath; cart.pathIndex = 0
      return true
    }
    break
  }

  // 直接朝目标点移动
  cart.x += (dx / d) * step
  cart.z += (dz / d) * step

  // 钳制在地图范围内，防止跑飞
  const MIN_X = GRID_MIN_X + 2, MAX_X = GRID_MIN_X + GRID_COLS * GRID_CELL - 2
  const MIN_Z = GRID_MIN_Z + 2, MAX_Z = GRID_MIN_Z + GRID_ROWS * GRID_CELL - 2
  cart.x = Math.max(MIN_X, Math.min(MAX_X, cart.x))
  cart.z = Math.max(MIN_Z, Math.min(MAX_Z, cart.z))

  // 小车之间互相避让（双向推离）
  for (const other of carts) {
    if (other.id === cart.id) continue
    const sx = cart.x - other.x, sz = cart.z - other.z
    const sd = Math.hypot(sx, sz)
    if (sd < 8 && sd > 0.1) {
      const push = (8 - sd) / 8 * step * 1.5
      cart.x += (sx / sd) * push
      cart.z += (sz / sd) * push
      // 把另一辆车也推开
      other.x -= (sx / sd) * push * 0.5
      other.z -= (sz / sd) * push * 0.5
    }
  }

  // 平滑旋转
  if (carMeshes[cart.id-1]) {
    carMeshes[cart.id-1].position.set(cart.x, Y_OFFSET, cart.z)
    const targetAngle = Math.atan2(cart.path[cart.pathIndex].x - cart.x, cart.path[cart.pathIndex].z - cart.z)
    let diff = targetAngle - carMeshes[cart.id-1].rotation.y
    while (diff > Math.PI) diff -= Math.PI * 2
    while (diff < -Math.PI) diff += Math.PI * 2
    const maxRot = Math.PI * dt
    const rot = Math.sign(diff) * Math.min(Math.abs(diff), maxRot)
    carMeshes[cart.id-1].rotation.y += rot
  }

  return true
}

// ===== 找最近料塔 =====
function findNearestSilo(cart) {
  let nearest = null, minDist = Infinity
  for (const silo of siloData) {
    const d = Math.hypot(silo.x - cart.x, silo.z - cart.z)
    if (d < minDist) { minDist = d; nearest = silo }
  }
  return nearest
}

// ===== 找最近充电桩（停车位）=====
function nearestCharger(cart) {
  // 小车回到充电桩旁边的停车位（充电桩在 x=-63/63）
  const px = cart.id === 1 ? -61 : 61
  return { x: px, z: 18 }
}

// ===== 更新小车逻辑 =====
function isPondBeingFed(pondId) {
  return carts.some(c => c.state === 'feeding' && c.target && c.target.task && c.target.task.tankId === pondId)
}

function updateCarts(dt) {
  if (!isRunning || isPaused) return

  for (const cart of carts) {
    // 电池消耗（充电和关机时不耗电）
    if (cart.state !== 'charging' && cart.state !== 'shutdown') {
      const drainRate = cart.battery < LOW_BATTERY_THRESHOLD ? BATTERY_DRAIN_RATE * 0.5 : BATTERY_DRAIN_RATE
      cart.battery -= drainRate * dt
      if (cart.battery <= 0) {
        cart.battery = 0
        cart.state = 'shutdown'
        continue
      }
    }

    switch (cart.state) {
      case 'idle':
        // 有任务直接出发
        if (taskQueue.length > 0) {
          const task = assignTask(cart)
          if (task) {
            cart.state = 'moving'
            cart.target = { x: ponds[task.tankId-1].x, z: ponds[task.tankId-1].z, task }
            cart.path = findPath(cart.x, cart.z, cart.target.x, cart.target.z)
            cart.pathIndex = 0
            break
          }
        }
        // 没任务就赶回充电桩
        const chIdle = nearestCharger(cart)
        if (Math.hypot(cart.x - chIdle.x, cart.z - chIdle.z) > 3) {
          cart.state = 'returning'
          cart.path = findPath(cart.x, cart.z, chIdle.x, chIdle.z)
          cart.pathIndex = 0
          break
        }
        // 已在充电桩位置
        cart.state = 'charging'
        break

      case 'moving': {
        if (cart.battery < LOW_BATTERY_THRESHOLD && cart.feed < LOW_FEED_LOWBATT_THRESHOLD) {
          // 先判断去充电还是补料
          const nearestS = findNearestSilo(cart)
          if (cart.feed < LOW_FEED_LOWBATT_THRESHOLD && nearestS) {
            cart.state = 'refill'
            cart.path = findPath(cart.x, cart.z, nearestS.x, nearestS.z)
            cart.pathIndex = 0
            break
          }
        }
        if (cart.battery < LOW_BATTERY_THRESHOLD) {
          const ch = nearestCharger(cart)
          cart.state = 'charging'
          cart.path = findPath(cart.x, cart.z, ch.x, ch.z)
          cart.pathIndex = 0
          break
        }
        if (cart.feed < LOW_FEED_THRESHOLD) {
          const silo = findNearestSilo(cart)
          if (silo) {
            cart.state = 'refill'
            cart.path = findPath(cart.x, cart.z, silo.x, silo.z)
            cart.pathIndex = 0
            break
          }
        }

        const moving = moveCart(cart, dt)
        if (!moving) {
          // 到达目标
          if (cart.target && cart.target.task) {
            if (isPondBeingFed(cart.target.task.tankId)) {
              cart.state = 'waiting'
            } else {
              cart.state = 'feeding'
              cart.waitTimer = FEED_TIME
              const pondFeed = ponds[cart.target.task.tankId - 1]
              pondFeed.lastFeedTime = simTime
              pondFeed.lastFeedAmount = cart.target.task.amount
            }
          } else {
            cart.state = 'idle'
          }
        }
        break
      }

      case 'waiting':
        if (cart.battery < LOW_BATTERY_THRESHOLD) {
          const ch = nearestCharger(cart)
          cart.state = 'charging'
          cart.path = findPath(cart.x, cart.z, ch.x, ch.z)
          cart.pathIndex = 0
          break
        }
        if (cart.target && cart.target.task && !isPondBeingFed(cart.target.task.tankId)) {
          cart.state = 'feeding'
          cart.waitTimer = FEED_TIME
          const pondFeed2 = ponds[cart.target.task.tankId - 1]
          pondFeed2.lastFeedTime = simTime
          pondFeed2.lastFeedAmount = cart.target.task.amount
        }
        break

      case 'feeding': {
        // 低电量中断投喂去充电
        if (cart.battery < LOW_BATTERY_THRESHOLD) {
          const pond = cart.target ? ponds[cart.target.task.tankId-1] : null
          if (pond) pond.isFeeding = false
          const ch = nearestCharger(cart)
          cart.state = 'charging'
          cart.path = findPath(cart.x, cart.z, ch.x, ch.z)
          cart.pathIndex = 0
          break
        }
        const pond = cart.target ? ponds[cart.target.task.tankId-1] : null
        if (pond) {
          if (!pond.isFeeding && pond.waterQuality > 10) {
            pond.waterQuality = Math.max(10, pond.waterQuality - 30)
            pond.qualityFeedFloor = pond.waterQuality
          }
          pond.isFeeding = true
          const feedRate = cart.target.task.amount / FEED_TIME
          const fed = feedRate * dt
          cart.feed -= fed
          pond.feedLevel += fed
          cart.waitTimer -= dt

          if (cart.feed < 0) cart.feed = 0

          // 中途没料了，中断投喂先去补料
          if (cart.feed <= 0 && cart.waitTimer > 0) {
            pond.isFeeding = false
            const silo = findNearestSilo(cart)
            cart.state = 'refill'
            cart.path = findPath(cart.x, cart.z, silo.x, silo.z)
            cart.pathIndex = 0
            break
          }

          if (cart.waitTimer <= 0) {
            pond.isFeeding = false
            cart.totalFed += cart.target.task.amount
            // 记录任务执行时间，不清除
            cart.target.task.lastRun = simTime
            cart.state = 'moving'
            cart.path = []
            cart.pathIndex = 0
            cart.target = null
            // 找下一个任务
            if (taskQueue.length > 0) {
              const task = assignTask(cart)
              if (task) {
                cart.state = 'moving'
                cart.target = { x: ponds[task.tankId-1].x, z: ponds[task.tankId-1].z, task }
                cart.path = findPath(cart.x, cart.z, cart.target.x, cart.target.z)
                cart.pathIndex = 0
              }
            } else {
              cart.state = 'idle'
            }
          }
        } else {
          cart.state = 'idle'
        }
        break
      }

      case 'refill': {
        if (cart.battery < LOW_BATTERY_THRESHOLD) {
          const ch = nearestCharger(cart)
          cart.state = 'charging'
          cart.path = findPath(cart.x, cart.z, ch.x, ch.z)
          cart.pathIndex = 0
          break
        }
        const silo = findNearestSilo(cart)
        if (Math.hypot(cart.x - silo.x, cart.z - silo.z) < 3) {
          // 补料
          const refill = REFILL_SPEED * dt
          const actual = Math.min(refill, cart.maxFeed - cart.feed)
          cart.feed += actual
          if (cart.feed >= cart.maxFeed) {
            // 补满后继续下一个任务
            cart.state = 'moving'
            if (cart.target) {
              cart.path = findPath(cart.x, cart.z, cart.target.x, cart.target.z)
              cart.pathIndex = 0
            } else {
              cart.state = 'idle'
            }
          }
          break
        }
        moveCart(cart, dt)
        break
      }

      case 'shutdown':
        // 完全关机，停在原地不动，不耗电
        break

      case 'returning': {
        // 赶回充电桩途中
        const ch = nearestCharger(cart)
        const dist = Math.hypot(cart.x - ch.x, cart.z - ch.z)
        if (dist < 12) {
          // 已接近，进入充电泊车流程
          cart.state = 'charging'
          break
        }
        if (!cart.path || cart.path.length === 0) {
          cart.path = findPath(cart.x, cart.z, ch.x, ch.z)
          cart.pathIndex = 0
        }
        moveCart(cart, dt)
        break
      }

      case 'charging': {
        const ch = nearestCharger(cart)
        const dx = ch.x - cart.x
        const dz = ch.z - cart.z
        const dist = Math.hypot(dx, dz)

        // 已到达停车位
        if (dist < 1.5) {
          cart.battery += BATTERY_CHARGE_RATE * dt
          if (cart.battery > 100) cart.battery = 100
          cart.x = ch.x; cart.z = ch.z
          if (carMeshes[cart.id-1]) {
            carMeshes[cart.id-1].position.set(cart.x, Y_OFFSET, cart.z)
            carMeshes[cart.id-1].rotation.y = Math.PI
          }
          if (taskQueue.length > 0) {
            const task = assignTask(cart)
            if (task) {
              cart.state = 'moving'
              cart.target = { x: ponds[task.tankId-1].x, z: ponds[task.tankId-1].z, task }
              cart.path = findPath(cart.x, cart.z, cart.target.x, cart.target.z)
              cart.pathIndex = 0
              break
            }
          }
          break
        }

        // 近距离：直驶入位，不再先开到南侧再倒车
        if (dist < 10) {
          const spd = CAR_SPEED * dt * 0.6
          const d = dist
          cart.x += (dx / d) * spd
          cart.z += (dz / d) * spd
          if (carMeshes[cart.id-1]) {
            carMeshes[cart.id-1].position.set(cart.x, Y_OFFSET, cart.z)
            const targetAngle = Math.atan2(dx, dz)
            let diff = targetAngle - carMeshes[cart.id-1].rotation.y
            while (diff > Math.PI) diff -= Math.PI * 2
            while (diff < -Math.PI) diff += Math.PI * 2
            carMeshes[cart.id-1].rotation.y += Math.sign(diff) * Math.min(Math.abs(diff), Math.PI * dt)
          }
          break
        }

        // 远距离：A* 导航到停车位附近
        if (!cart.path || cart.path.length === 0) {
          cart.path = findPath(cart.x, cart.z, ch.x, ch.z)
          cart.pathIndex = 0
        }
        moveCart(cart, dt)
        break
      }
    }
  }
}

// ===== 分配任务给小车（分配即从队列移除）=====
function assignTask(cart) {
  // 找第一个满足：属于该小车 + (从未执行过 or 间隔已到) + 鱼塘不在投喂中
  for (const task of taskQueue) {
    if (task.cartId !== 0 && task.cartId !== cart.id) continue
    if (isPondBeingFed(task.tankId)) continue
    if (task.lastRun === 0) return task
    if (task.interval > 0 && (simTime - task.lastRun) >= task.interval * 3600) return task
  }
  return null
}

// ===== 更新 UI =====
function updateUI(dt) {
  // 鱼塘标签
  ponds.forEach((p, i) => {
    if (tankLabels[i]) {
      const div = tankLabels[i].element
      div.textContent = `#${p.id}${p.isFeeding ? ' 投喂中' : ''}`
      div.style.background = p.isFeeding ? 'rgba(0,200,80,0.8)' : 'rgba(0,0,0,0.6)'
    }
  })

  // 小车状态
  const stateNames = {'idle':'待机','moving':'移动','feeding':'投喂','refill':'补料','charging':'充电','returning':'赶回','waiting':'等待','shutdown':'关机'}
  carts.forEach((cart, i) => {
    const el = document.getElementById(`cart${i+1}-info`)
    if (!el) return
    const stateClass = cart.state
    el.innerHTML = `<div class="info-row"><span><span class="cart-status-icon ${stateClass}"></span>小车${cart.id}</span><span class="badge ${stateClass}">${stateNames[cart.state]||cart.state}</span></div>
    <div class="info-row"><span>电量</span><span class="${cart.battery<30?'battery-low':'battery-ok'}">${cart.battery.toFixed(1)}%</span></div>
    <div class="info-row"><span>余料</span><span>${cart.feed.toFixed(1)}kg</span></div>`
  })

  // 任务列表（每帧重绘，显示倒计时）
  const taskListEl = document.getElementById('task-list')
  if (taskListEl) {
    taskListEl.innerHTML = taskQueue.map((t) => {
      let status = ''
      if (t.interval > 0) {
        if (t.lastRun === 0) status = '<span style="color:#69f0ae;font-size:10px;">待首发</span>'
        else {
          const remaining = t.interval * 3600 - (simTime - t.lastRun)
          if (remaining <= 0) status = '<span style="color:#69f0ae;font-size:10px;">待执行</span>'
          else {
            const rh = Math.floor(remaining / 3600)
            const rm = Math.floor((remaining % 3600) / 60)
            status = '<span style="color:#ffd600;font-size:10px;">'+rh+'h'+rm+'m</span>'
          }
        }
      }
      return '<li style="display:flex;flex-wrap:wrap;align-items:center;padding:3px 6px;margin:2px 0;background:rgba(255,255,255,0.05);border-radius:4px;font-size:11px;">'
        + '<span style="flex:1;">桶#'+t.tankId+' '+t.amount+'kg'+(t.cartId>0?'(车'+t.cartId+')':'')+'</span>'
        + '<span style="margin:0 4px;">'+status+'</span>'
        + '<span style="color:#aaa;font-size:10px;margin-right:4px;">每'+t.interval+'h</span>'
        + '<span class="task-del" data-id="'+t.id+'" style="cursor:pointer;color:#ff5252;font-size:11px;padding:2px 6px;border-radius:3px;background:rgba(255,50,50,0.1);">删</span>'
        + '</li>'
    }).join('')
  }

  // 统计
  const fedCount = ponds.filter(p => p.feedLevel > 0).length
  document.getElementById('fed-count').textContent = fedCount
  document.getElementById('task-count').textContent = taskQueue.length

  // 水质逻辑：基于模拟时间
  for (const p of ponds) {
    if (p.lastQualityCheck === 0) p.lastQualityCheck = simTime

    let elapsed = simTime - p.lastQualityCheck

    // 每半小时降1点
    if (elapsed >= 1800) {
      const halfHours = Math.floor(elapsed / 1800)
      p.waterQuality = Math.max(10, p.waterQuality - halfHours)
      p.lastQualityCheck += halfHours * 1800
    }

    // 投喂后回升：只有实际发生过投喂（floor被设置过）才触发
    // 回升速度 1点/分钟，最多升到 floor+20
    if (p.qualityFeedFloor < 95) {
      const recoveryCap = p.qualityFeedFloor + 20
      if (p.waterQuality < recoveryCap) {
        elapsed = simTime - p.lastQualityCheck
        if (elapsed >= 60) {
          const mins = Math.floor(elapsed / 60)
          p.waterQuality = Math.min(recoveryCap, p.waterQuality + mins)
          p.lastQualityCheck += mins * 60
        }
      }
    }
  }

  // 模拟时间（带秒格）
  const h = Math.floor(simTime / 3600) % 24
  const m = Math.floor((simTime % 3600) / 60)
  const s = Math.floor(simTime % 60)
  const timeStr = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`
  const timeStrFull = `${timeStr}:${String(s).padStart(2,'0')}`
  document.getElementById('sim-time').textContent = timeStrFull
  const numEl = document.getElementById('sim-time-num')
  if (numEl) numEl.textContent = timeStrFull

  // 根据水质更新水面颜色
  for (let i = 0; i < ponds.length; i++) {
    const wm = tankWaterMeshes[i]
    if (!wm || !wm.material) continue
    const wq = ponds[i].waterQuality
    // 优(80+)→清澈蓝绿  良(60-80)→翠绿  中(40-60)→黄绿  差(<40)→浑浊棕绿
    let r, g, b
    if (wq >= 80) { r=0.1; g=0.7; b=0.7 }
    else if (wq >= 60) { r=0.15 + (80-wq)/100; g=0.55 + (wq-60)/100; b=0.5 }
    else if (wq >= 40) { r=0.3 + (60-wq)/80; g=0.45 + (wq-40)/120; b=0.3 }
    else { r=0.45 + (40-wq)/100; g=0.35 + (wq)/200; b=0.2 }
    wm.material.color.setRGB(Math.min(1,r), Math.min(1,g), Math.min(1,b))
    // 水质差时降低透明度
    const opacity = 0.2 + (wq / 100) * 0.5
    wm.material.transparent = true
    wm.material.opacity = opacity
  }

  // 渲染鱼塘数据表格
  renderPondTable()
}

// 鱼塘数据表格
let _pondSearchTerm = ''
function renderPondTable() {
  const tbody = document.getElementById('pond-table-body')
  if (!tbody) return
  const term = _pondSearchTerm.toLowerCase()
  let shown = 0
  let html = ''
  for (const p of ponds) {
    if (term && !String(p.id).includes(term) && !String(p.fishCount).includes(term)) continue
    shown++

    // 水质颜色
    const wq = p.waterQuality
    let wqColor = '#ff5252'
    let wqLabel = '差'
    if (wq >= 80) { wqColor = '#69f0ae'; wqLabel = '优' }
    else if (wq >= 60) { wqColor = '#ffd600'; wqLabel = '良' }
    else if (wq >= 40) { wqColor = '#ff9100'; wqLabel = '中' }

    // 上次投喂时间
    let feedTimeStr = '--:--:--'
    let feedAmtStr = '-'
    if (p.lastFeedTime > 0) {
      const fh = Math.floor(p.lastFeedTime / 3600) % 24
      const fm = Math.floor((p.lastFeedTime % 3600) / 60)
      feedTimeStr = `${String(fh).padStart(2,'0')}:${String(fm).padStart(2,'0')}`
      feedAmtStr = p.lastFeedAmount.toFixed(1) + 'kg'
    }

    html += `<tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
      <td style="padding:2px 4px; text-align:left;">#${p.id}</td>
      <td style="padding:2px 4px; text-align:center;">${p.fishCount}</td>
      <td style="padding:2px 4px; text-align:center; color:${wqColor};">${wqLabel} ${wq.toFixed(0)}</td>
      <td style="padding:2px 4px; text-align:center;">${feedTimeStr}</td>
      <td style="padding:2px 4px; text-align:right;">${feedAmtStr}</td>
    </tr>`
  }
  tbody.innerHTML = html
  document.getElementById('pond-show-count').textContent = shown
}

// ===== 动画循环 =====
const clock = new THREE.Timer()

function animate() {
  clock.update()
  const rawDt = clock.getDelta()
  const dt = rawDt * simSpeed

  // WASD
  if (keys.w || keys.a || keys.s || keys.d || keys.q || keys.e) {
    const spd = 8 * rawDt * (keys.shift ? 3 : 1)
    const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize()
    const right = new THREE.Vector3(); right.crossVectors(fwd, new THREE.Vector3(0,1,0)).normalize()
    const mv = new THREE.Vector3()
    if (keys.w) mv.add(fwd); if (keys.s) mv.sub(fwd); if (keys.a) mv.sub(right); if (keys.d) mv.add(right)
    mv.normalize().multiplyScalar(spd); camera.position.add(mv)
    if (keys.q) camera.position.y += spd; if (keys.e) camera.position.y -= spd
    const lt = new THREE.Vector3(); camera.getWorldDirection(lt)
    controls.target.copy(camera.position).add(lt.multiplyScalar(30))
  }

  // 时间自然流动（不受暂停控制）
  simTime += dt

  // 小车逻辑只在运行时执行
  if (isRunning && !isPaused) {
    updateCarts(dt)
  }

  updateFish(rawDt)
  updateSkyAndLighting(simTime)
  controls.update()
  renderer.render(scene, camera)
  labelRenderer.render(scene, camera)
  updateUI(dt)
  requestAnimationFrame(animate)
}

animate()

// ===== UI 绑定 =====
document.getElementById('btn-start-sim')?.addEventListener('click', () => {
  isRunning = true; isPaused = false
  document.getElementById('btn-start-sim').style.background = '#00e676'
  document.getElementById('btn-pause-sim').textContent = '⏸ 暂停'
})
document.getElementById('btn-pause-sim')?.addEventListener('click', () => {
  isPaused = !isPaused
  document.getElementById('btn-pause-sim').textContent = isPaused ? '▶ 继续' : '⏸ 暂停'
})
document.getElementById('btn-reset-sim')?.addEventListener('click', () => {
  isRunning = false; isPaused = false; simTime = 8 * 3600
  carts.forEach(c => { c.battery=100; c.feed=50; c.state='idle'; c.target=null; c.path=[]; c.pathIndex=0; c.totalFed=0 })
  ponds.forEach(p => { p.feedLevel=0; p.isFeeding=false })
  carMeshes.forEach((cm,i) => {if(cm){cm.position.set(carts[i].x,Y_OFFSET,carts[i].z);cm.rotation.y=Math.PI}})
  taskQueue.length = 0; nextTaskId = 1; for(let i=0;i<8;i++) taskQueue.push({tankId:i+1,amount:ponds[i].fishCount*1,cartId:0,id:nextTaskId++,interval:6,lastRun:0})
  document.getElementById('btn-start-sim').style.background = '#00c853'
  document.getElementById('btn-pause-sim').textContent = '⏸ 暂停'
})

document.getElementById('btn-clear-tasks')?.addEventListener('click', () => {
  const activeTasks = carts.map(c => c.target && c.target.task).filter(Boolean)
  for (let i = taskQueue.length - 1; i >= 0; i--) {
    if (!activeTasks.includes(taskQueue[i])) taskQueue.splice(i, 1)
  }
})

document.getElementById('btn-add-task')?.addEventListener('click', () => {
  const tank = parseInt(document.getElementById('task-tank').value)
  const amount = parseFloat(document.getElementById('task-amount').value)
  const cartId = parseInt(document.getElementById('task-cart').value)
  const interval = parseFloat(document.getElementById('task-interval').value) || 0
  if (tank >= 1 && tank <= 20 && amount > 0) {
    taskQueue.push({tankId: tank, amount, cartId, id: nextTaskId++, interval, lastRun: 0})
  }
})

document.getElementById('speed-slider')?.addEventListener('input', (e) => {
  simSpeed = parseFloat(e.target.value)
  document.getElementById('speed-label').textContent = simSpeed.toFixed(1) + 'x'
  document.getElementById('sim-speed-display').textContent = simSpeed.toFixed(1) + 'x'
})

// ===== 阈值设置 =====
document.getElementById('thresholds-toggle')?.addEventListener('click', () => {
  const panel = document.getElementById('thresholds-panel')
  const toggle = document.getElementById('thresholds-toggle')
  if (panel.style.display === 'none') {
    panel.style.display = 'block'
    toggle.innerHTML = '&#9660; 小车阈值设置'
  } else {
    panel.style.display = 'none'
    toggle.innerHTML = '&#9654; 小车阈值设置'
  }
})

document.getElementById('th-battery')?.addEventListener('input', (e) => {
  LOW_BATTERY_THRESHOLD = parseFloat(e.target.value)
  document.getElementById('th-battery-val').textContent = LOW_BATTERY_THRESHOLD + '%'
})

document.getElementById('th-feed')?.addEventListener('input', (e) => {
  LOW_FEED_THRESHOLD = parseFloat(e.target.value)
  document.getElementById('th-feed-val').textContent = LOW_FEED_THRESHOLD.toFixed(1) + 'kg'
})

document.getElementById('th-feed-lowbatt')?.addEventListener('input', (e) => {
  LOW_FEED_LOWBATT_THRESHOLD = parseFloat(e.target.value)
  document.getElementById('th-feed-lowbatt-val').textContent = LOW_FEED_LOWBATT_THRESHOLD.toFixed(1) + 'kg'
})

// ===== 任务删除（一次性绑定，永不过期）=====
document.getElementById('task-list')?.addEventListener('click', function(e) {
  const btn = e.target.closest('.task-del')
  if (!btn) return
  const id = parseInt(btn.dataset.id)
  const idx = taskQueue.findIndex(t => t.id === id)
  if (idx >= 0) taskQueue.splice(idx, 1)
})

// ===== 时间调节按钮（水质同步跳到相应时间的数值）=====
function adjustTime(deltaSec) {
  const oldTime = simTime
  simTime = Math.max(0, simTime + deltaSec)
  const elapsed = Math.abs(simTime - oldTime)
  if (elapsed < 60) { for (const p of ponds) p.lastQualityCheck = simTime; return }

  for (const p of ponds) {
    if (p.lastQualityCheck === 0) { p.lastQualityCheck = oldTime; continue }
    const hadFeeding = p.qualityFeedFloor < 95
    const recoveryCap = p.qualityFeedFloor + 20

    if (simTime > oldTime) {
      // 时间前进：先回升再自然下降
      let wq = p.waterQuality
      // 投喂回升
      if (hadFeeding && wq < recoveryCap) {
        const mins = Math.floor(elapsed / 60)
        wq = Math.min(recoveryCap, wq + mins)
      }
      // 自然下降（回升后再降，避免回升和下降互相抵消）
      const halfHours = Math.floor(elapsed / 1800)
      wq = Math.max(10, wq - halfHours)
      p.waterQuality = wq
    } else {
      // 时间后退
      let wq = p.waterQuality
      // 反向：先补回自然下降的部分
      const halfHours = Math.floor(elapsed / 1800)
      wq = Math.min(95, wq + halfHours)
      // 再反向投喂回升（即投喂后的回升倒退）
      if (hadFeeding && wq > recoveryCap) {
        const mins = Math.floor(elapsed / 60)
        wq = Math.max(recoveryCap, wq - mins)
      }
      p.waterQuality = wq
    }
    p.lastQualityCheck = simTime
  }
}
document.getElementById('time-hh-down')?.addEventListener('click', () => adjustTime(-3600))
document.getElementById('time-hh-up')?.addEventListener('click', () => adjustTime(3600))
document.getElementById('time-mm-down')?.addEventListener('click', () => adjustTime(-600))
document.getElementById('time-mm-up')?.addEventListener('click', () => adjustTime(600))

// ===== 鱼塘数据面板切换/搜索 =====
document.getElementById('pond-data-toggle')?.addEventListener('click', () => {
  const panel = document.getElementById('pond-data-panel')
  const toggle = document.getElementById('pond-data-toggle')
  if (panel.style.display === 'none' || !panel.style.display) {
    panel.style.display = 'block'
    toggle.innerHTML = '&#9660; 鱼塘数据面板'
  } else {
    panel.style.display = 'none'
    toggle.innerHTML = '&#9654; 鱼塘数据面板'
  }
})

document.getElementById('pond-search')?.addEventListener('input', (e) => {
  _pondSearchTerm = e.target.value
})

// ===== 窗口自适应 =====
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
  labelRenderer.setSize(window.innerWidth, window.innerHeight)
})
