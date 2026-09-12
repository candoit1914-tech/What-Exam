/* Three.js 3D Background — floating emerald particles with depth */

(function () {
  if (typeof THREE === 'undefined') return;

  const canvas = document.createElement('canvas');
  canvas.id = 'three-bg';
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:-1;pointer-events:none;';
  document.body.prepend(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.z = 5;

  // ── Particles ──
  const COUNT = 80;
  const positions = new Float32Array(COUNT * 3);
  const sizes = new Float32Array(COUNT);
  const speeds = new Float32Array(COUNT);
  const phases = new Float32Array(COUNT);

  for (let i = 0; i < COUNT; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 20;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 20;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 10 - 2;
    sizes[i] = Math.random() * 3 + 1;
    speeds[i] = Math.random() * 0.3 + 0.05;
    phases[i] = Math.random() * Math.PI * 2;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uColor1: { value: new THREE.Color(0x25d366) },
      uColor2: { value: new THREE.Color(0x10b981) },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    },
    vertexShader: `
      attribute float aSize;
      uniform float uTime;
      uniform float uPixelRatio;
      varying float vAlpha;
      void main() {
        vec3 pos = position;
        pos.y += sin(uTime * 0.3 + position.x * 0.5) * 0.4;
        pos.x += cos(uTime * 0.2 + position.y * 0.3) * 0.3;
        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        gl_PointSize = aSize * uPixelRatio * (4.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
        vAlpha = smoothstep(10.0, 2.0, -mv.z) * 0.6;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor1;
      uniform vec3 uColor2;
      uniform float uTime;
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float glow = exp(-d * 3.0);
        vec3 col = mix(uColor1, uColor2, sin(uTime * 0.5 + gl_PointCoord.y) * 0.5 + 0.5);
        gl_FragColor = vec4(col, glow * vAlpha);
      }
    `,
  });

  const points = new THREE.Points(geo, mat);
  scene.add(points);

  // ── Floating geometry ──
  const shapes = [];
  const geometries = [
    new THREE.IcosahedronGeometry(0.3, 0),
    new THREE.OctahedronGeometry(0.25, 0),
    new THREE.TetrahedronGeometry(0.28, 0),
  ];

  for (let i = 0; i < 6; i++) {
    const geo = geometries[i % geometries.length];
    const mat = new THREE.MeshBasicMaterial({
      color: i % 2 === 0 ? 0x25d366 : 0x10b981,
      wireframe: true,
      transparent: true,
      opacity: 0.15,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 6 - 3);
    mesh.userData = {
      rotSpeed: (Math.random() - 0.5) * 0.01,
      floatSpeed: Math.random() * 0.2 + 0.1,
      floatPhase: Math.random() * Math.PI * 2,
      baseY: mesh.position.y,
    };
    scene.add(mesh);
    shapes.push(mesh);
  }

  // ── Mouse parallax ──
  let mouseX = 0, mouseY = 0;
  document.addEventListener('mousemove', (e) => {
    mouseX = (e.clientX / window.innerWidth - 0.5) * 2;
    mouseY = (e.clientY / window.innerHeight - 0.5) * 2;
  }, { passive: true });

  // ── Animate ──
  let running = true;
  function animate() {
    if (!running) return;
    requestAnimationFrame(animate);
    const t = performance.now() * 0.001;
    mat.uniforms.uTime.value = t;

    camera.position.x += (mouseX * 0.3 - camera.position.x) * 0.02;
    camera.position.y += (-mouseY * 0.3 - camera.position.y) * 0.02;
    camera.lookAt(0, 0, 0);

    for (const s of shapes) {
      s.rotation.x += s.userData.rotSpeed;
      s.rotation.y += s.userData.rotSpeed * 1.3;
      s.position.y = s.userData.baseY + Math.sin(t * s.userData.floatSpeed + s.userData.floatPhase) * 0.5;
    }

    renderer.render(scene, camera);
  }
  animate();

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Cleanup on navigation to admin views (save GPU)
  window.addEventListener('hashchange', () => {
    const isAdmin = location.hash.startsWith('#/exams') || location.hash.startsWith('#/results') ||
                    location.hash.startsWith('#/messages') || location.hash.startsWith('#/reviews') ||
                    location.hash.startsWith('#/students');
    canvas.style.display = isAdmin ? 'none' : '';
    if (isAdmin) running = false;
    else { running = true; animate(); }
  });
})();
