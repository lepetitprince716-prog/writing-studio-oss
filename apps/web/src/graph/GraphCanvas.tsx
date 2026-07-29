import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import {
  Html,
  MapControls,
  OrbitControls,
  OrthographicCamera,
  PerspectiveCamera,
} from '@react-three/drei';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import {
  AdditiveBlending,
  BufferAttribute,
  Color,
  InstancedMesh,
  LineSegments,
  Matrix4,
  Quaternion,
  Vector3,
} from 'three';
import type { BufferGeometry, LineBasicMaterial, LineDashedMaterial } from 'three';
import { forceCenter, forceLink, forceManyBody, forceSimulation } from 'd3-force-3d';
import type { ForceNode, LinkDatum } from 'd3-force-3d';
import type { WorldGraphSnapshot, WorldNode } from '@writing-studio/contract';
import type { DisplayGraph } from './derive.js';
import { degrees, nodeSize } from './derive.js';
import { edgeColor, graphCanvasColor, nodeColor } from './palette.js';

export type GraphVisualMode = 'local2d' | 'global3d';

export interface GraphForces {
  center: number;
  charge: number;
  link: number;
  distance: number;
}

interface FocusRequest {
  id: string;
  token: number;
}

interface GraphCanvasProps {
  graph: DisplayGraph;
  snapshot: WorldGraphSnapshot;
  mode: GraphVisualMode;
  selectedNodeId: string | null;
  focusRequest: FocusRequest | null;
  forces: GraphForces;
  reducedMotion: boolean;
  bloom: boolean;
  onSelectNode(id: string): void;
  onFocusNode(id: string): void;
  onUnavailable(): void;
}

interface LayoutNode extends ForceNode {
  id: string;
  data: WorldNode;
  x: number;
  y: number;
  z: number;
}

interface LayoutLink extends LinkDatum<LayoutNode> {
  edgeIndex: number;
}

interface MutablePosition {
  x: number;
  y: number;
  z: number;
}

function deterministicUnit(value: string, salt: number): number {
  let hash = 2166136261 ^ salt;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function CanvasFailure({ onUnavailable }: { onUnavailable(): void }): null {
  useEffect(() => onUnavailable(), [onUnavailable]);
  return null;
}

function Scene({
  graph,
  snapshot,
  mode,
  selectedNodeId,
  focusRequest,
  forces,
  reducedMotion,
  bloom,
  onSelectNode,
  onFocusNode,
  onUnavailable,
}: GraphCanvasProps): React.JSX.Element {
  const meshRef = useRef<InstancedMesh | null>(null);
  const haloRef = useRef<InstancedMesh | null>(null);
  const arrowRef = useRef<InstancedMesh | null>(null);
  const confirmedRef = useRef<LineSegments<BufferGeometry, LineBasicMaterial> | null>(null);
  const inferredRef = useRef<LineSegments<BufferGeometry, LineBasicMaterial> | null>(null);
  const questionRef = useRef<LineSegments<BufferGeometry, LineDashedMaterial> | null>(null);
  const positionCache = useRef(new Map<string, MutablePosition>());
  const mapControlsRef = useRef<React.ComponentRef<typeof MapControls> | null>(null);
  const orbitControlsRef = useRef<React.ComponentRef<typeof OrbitControls> | null>(null);
  const [settledVersion, setSettledVersion] = useState(0);
  const { camera, gl, invalidate } = useThree();
  const degree = useMemo(() => degrees(graph), [graph]);
  const nodeType = useMemo(() => new Map(snapshot.nodeTypes.map((type) => [type.id, type])), [snapshot.nodeTypes]);
  const relationType = useMemo(
    () => new Map(snapshot.relationTypes.map((type) => [type.id, type])),
    [snapshot.relationTypes],
  );
  const nodes = useMemo<LayoutNode[]>(() => graph.nodes.map((node, index) => {
    const prior = positionCache.current.get(node.id);
    const angle = deterministicUnit(node.id, 17) * Math.PI * 2;
    const radius = 18 + Math.sqrt(index + 1) * 10;
    return {
      id: node.id,
      data: node,
      x: prior?.x ?? Math.cos(angle) * radius,
      y: prior?.y ?? Math.sin(angle) * radius,
      z: mode === 'local2d' ? 0 : prior?.z ?? (deterministicUnit(node.id, 53) - 0.5) * 70,
    };
  }), [graph.nodes, mode]);
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const links = useMemo<LayoutLink[]>(() => graph.edges.map((edge, edgeIndex) => ({
    source: edge.sourceId,
    target: edge.targetId,
    edgeIndex,
  })), [graph.edges, nodes]);
  const confirmedEdges = useMemo(
    () => graph.edges.map((edge, index) => ({ edge, index })).filter(({ edge }) => edge.confidence === 'confirmed'),
    [graph.edges],
  );
  const inferredEdges = useMemo(
    () => graph.edges.map((edge, index) => ({ edge, index })).filter(({ edge }) => edge.confidence === 'inferred'),
    [graph.edges],
  );
  const questionEdges = useMemo(
    () => graph.edges.map((edge, index) => ({ edge, index })).filter(({ edge }) => edge.confidence === 'question'),
    [graph.edges],
  );
  const confirmedPositions = useMemo(() => new Float32Array(confirmedEdges.length * 6), [confirmedEdges]);
  const confirmedColors = useMemo(() => new Float32Array(confirmedEdges.length * 6), [confirmedEdges]);
  const inferredPositions = useMemo(() => new Float32Array(inferredEdges.length * 6), [inferredEdges]);
  const inferredColors = useMemo(() => new Float32Array(inferredEdges.length * 6), [inferredEdges]);
  const questionPositions = useMemo(() => new Float32Array(questionEdges.length * 6), [questionEdges]);
  const questionColors = useMemo(() => new Float32Array(questionEdges.length * 6), [questionEdges]);
  const directedEdges = useMemo(
    () => graph.edges.filter((edge) => relationType.get(edge.relationTypeId)?.directed),
    [graph.edges, relationType],
  );
  const haloNodes = useMemo(
    () => nodes.filter((node) => (
      nodeType.get(node.data.typeId)?.visualFamily === 'foreshadow'
      && node.data.inactiveFrom === null
    )),
    [nodeType, nodes],
  );
  const selectedNeighbors = useMemo(() => {
    if (!selectedNodeId) return null;
    const result = new Set([selectedNodeId]);
    for (const edge of graph.edges) {
      if (edge.sourceId === selectedNodeId) result.add(edge.targetId);
      if (edge.targetId === selectedNodeId) result.add(edge.sourceId);
    }
    return result;
  }, [graph.edges, selectedNodeId]);

  const updatePositions = useCallback(() => {
    const mesh = meshRef.current;
    const halos = haloRef.current;
    const arrows = arrowRef.current;
    if (!mesh) return;
    const matrix = new Matrix4();
    const position = new Vector3();
    const scale = new Vector3();
    const quaternion = new Quaternion();
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index]!;
      const z = mode === 'local2d' ? 0 : node.z || 0;
      node.z = z;
      position.set(node.x || 0, node.y || 0, z);
      const family = nodeType.get(node.data.typeId)?.visualFamily ?? 'unknown';
      const radius = nodeSize(node.data, degree.get(node.id) ?? 0, family) * 0.22;
      scale.setScalar(Math.max(0.5, radius));
      quaternion.identity();
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(index, matrix);
      positionCache.current.set(node.id, { x: position.x, y: position.y, z: position.z });
    }
    mesh.instanceMatrix.needsUpdate = true;

    if (halos) {
      for (let index = 0; index < haloNodes.length; index += 1) {
        const node = haloNodes[index]!;
        const radius = nodeSize(node.data, degree.get(node.id) ?? 0, 'foreshadow') * 0.34;
        position.set(node.x || 0, node.y || 0, mode === 'local2d' ? 0 : node.z || 0);
        scale.setScalar(Math.max(0.9, radius));
        quaternion.identity();
        matrix.compose(position, quaternion, scale);
        halos.setMatrixAt(index, matrix);
      }
      halos.instanceMatrix.needsUpdate = true;
    }

    const updateEdgeLayer = (
      entries: Array<{ edge: (typeof graph.edges)[number]; index: number }>,
      positions: Float32Array,
      colors: Float32Array,
      ref: { current: LineSegments<BufferGeometry, LineBasicMaterial | LineDashedMaterial> | null },
    ): void => {
      for (let index = 0; index < entries.length; index += 1) {
        const { edge } = entries[index]!;
        const source = nodeById.get(edge.sourceId);
        const target = nodeById.get(edge.targetId);
        if (!source || !target) continue;
        positions.set([source.x, source.y, mode === 'local2d' ? 0 : source.z, target.x, target.y, mode === 'local2d' ? 0 : target.z], index * 6);
      }
      const geometry = ref.current?.geometry;
      if (geometry) {
        (geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
        (geometry.getAttribute('color') as BufferAttribute).needsUpdate = true;
      }
    };
    updateEdgeLayer(confirmedEdges, confirmedPositions, confirmedColors, confirmedRef);
    updateEdgeLayer(inferredEdges, inferredPositions, inferredColors, inferredRef);
    updateEdgeLayer(questionEdges, questionPositions, questionColors, questionRef);
    questionRef.current?.computeLineDistances();

    if (arrows) {
      const up = new Vector3(0, 1, 0);
      for (let index = 0; index < directedEdges.length; index += 1) {
        const edge = directedEdges[index]!;
        const source = nodeById.get(edge.sourceId);
        const target = nodeById.get(edge.targetId);
        if (!source || !target) continue;
        const from = new Vector3(source.x, source.y, mode === 'local2d' ? 0 : source.z);
        const to = new Vector3(target.x, target.y, mode === 'local2d' ? 0 : target.z);
        const direction = to.clone().sub(from);
        const location = from.clone().lerp(to, 0.72);
        quaternion.setFromUnitVectors(up, direction.normalize());
        scale.setScalar(1);
        matrix.compose(location, quaternion, scale);
        arrows.setMatrixAt(index, matrix);
      }
      arrows.instanceMatrix.needsUpdate = true;
    }
    invalidate();
  }, [
    confirmedColors,
    confirmedEdges,
    confirmedPositions,
    degree,
    directedEdges,
    graph.edges,
    haloNodes,
    inferredColors,
    inferredEdges,
    inferredPositions,
    invalidate,
    mode,
    nodeById,
    nodeType,
    nodes,
    questionColors,
    questionEdges,
    questionPositions,
  ]);

  useEffect(() => {
    const applyLayerColors = (
      entries: Array<{ edge: (typeof graph.edges)[number]; index: number }>,
      colors: Float32Array,
    ): void => {
      for (let index = 0; index < entries.length; index += 1) {
        const { edge } = entries[index]!;
        const family = relationType.get(edge.relationTypeId)?.visualFamily ?? 'custom';
        const color = new Color(edgeColor(family));
        const connected = !selectedNodeId || edge.sourceId === selectedNodeId || edge.targetId === selectedNodeId;
        if (!connected) color.multiplyScalar(0.16);
        colors.set([color.r, color.g, color.b, color.r, color.g, color.b], index * 6);
      }
    };
    applyLayerColors(confirmedEdges, confirmedColors);
    applyLayerColors(inferredEdges, inferredColors);
    applyLayerColors(questionEdges, questionColors);
    const mesh = meshRef.current;
    if (mesh) {
      nodes.forEach((node, index) => {
        const family = nodeType.get(node.data.typeId)?.visualFamily ?? 'unknown';
        const color = new Color(nodeColor(family));
        if (selectedNeighbors && !selectedNeighbors.has(node.id)) color.multiplyScalar(0.18);
        mesh.setColorAt(index, color);
      });
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    const arrows = arrowRef.current;
    if (arrows) {
      directedEdges.forEach((edge, index) => {
        const family = relationType.get(edge.relationTypeId)?.visualFamily ?? 'custom';
        const color = new Color(edgeColor(family));
        if (selectedNodeId && edge.sourceId !== selectedNodeId && edge.targetId !== selectedNodeId) color.multiplyScalar(0.16);
        arrows.setColorAt(index, color);
      });
      if (arrows.instanceColor) arrows.instanceColor.needsUpdate = true;
    }
    updatePositions();
  }, [
    confirmedColors,
    confirmedEdges,
    directedEdges,
    inferredColors,
    inferredEdges,
    nodeType,
    nodes,
    questionColors,
    questionEdges,
    relationType,
    selectedNeighbors,
    selectedNodeId,
    updatePositions,
  ]);

  useEffect(() => {
    const dimensions = mode === 'local2d' ? 2 : 3;
    const simulation = forceSimulation(nodes, dimensions)
      .alphaMin(0.01)
      .velocityDecay(0.38)
      .force('center', forceCenter<LayoutNode>(0, 0, 0).strength(forces.center))
      .force('charge', forceManyBody<LayoutNode>().strength(forces.charge))
      .force(
        'link',
        forceLink<LayoutNode, LayoutLink>(links)
          .id((node) => node.id)
          .distance(forces.distance)
          .strength(forces.link),
      )
      .on('tick', updatePositions)
      .on('end', () => {
        updatePositions();
        setSettledVersion((value) => value + 1);
      });
    simulation.alpha(0.9).restart();
    return () => {
      simulation.stop();
    };
  }, [forces.center, forces.charge, forces.distance, forces.link, links, mode, nodes, updatePositions]);

  useEffect(() => {
    const canvas = gl.domElement;
    const onLost = (event: Event): void => {
      event.preventDefault();
      onUnavailable();
    };
    canvas.addEventListener('webglcontextlost', onLost);
    return () => canvas.removeEventListener('webglcontextlost', onLost);
  }, [gl, onUnavailable]);

  useEffect(() => {
    if (!focusRequest) return;
    const node = nodeById.get(focusRequest.id);
    if (!node) return;
    const target = new Vector3(node.x, node.y, mode === 'local2d' ? 0 : node.z);
    const controls = mode === 'local2d' ? mapControlsRef.current : orbitControlsRef.current;
    controls?.target.copy(target);
    const offset = mode === 'local2d' ? new Vector3(0, 0, 90) : new Vector3(35, 28, 45);
    camera.position.copy(target).add(offset);
    camera.lookAt(target);
    controls?.update();
    invalidate();
  }, [camera, focusRequest, invalidate, mode, nodeById]);

  const onPointerDown = (event: ThreeEvent<PointerEvent>): void => {
    event.stopPropagation();
    if (event.instanceId !== undefined) onSelectNode(nodes[event.instanceId]!.id);
  };
  const onDoubleClick = (event: ThreeEvent<MouseEvent>): void => {
    event.stopPropagation();
    if (event.instanceId !== undefined) onFocusNode(nodes[event.instanceId]!.id);
  };
  const labelNodes = useMemo(
    () => [...nodes]
      .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.id.localeCompare(b.id))
      .slice(0, 40),
    // settledVersion intentionally causes one label position refresh after layout stops.
    [degree, nodes, settledVersion],
  );

  return (
    <>
      {mode === 'local2d' ? (
        <>
          <OrthographicCamera makeDefault position={[0, 0, 90]} zoom={5} near={0.1} far={1000} />
          <MapControls ref={mapControlsRef} makeDefault enableRotate={false} enableDamping={!reducedMotion} />
        </>
      ) : (
        <>
          <PerspectiveCamera makeDefault position={[40, 30, 55]} fov={48} near={0.1} far={2000} />
          <OrbitControls ref={orbitControlsRef} makeDefault enableDamping={!reducedMotion} />
        </>
      )}
      <color attach="background" args={[graphCanvasColor('background')]} />
      <fog attach="fog" args={[graphCanvasColor('fog'), 180, 520]} />
      <lineSegments ref={confirmedRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[confirmedPositions, 3]} />
          <bufferAttribute attach="attributes-color" args={[confirmedColors, 3]} />
        </bufferGeometry>
        <lineBasicMaterial vertexColors transparent opacity={0.78} blending={AdditiveBlending} depthWrite={false} />
      </lineSegments>
      <lineSegments ref={inferredRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[inferredPositions, 3]} />
          <bufferAttribute attach="attributes-color" args={[inferredColors, 3]} />
        </bufferGeometry>
        <lineBasicMaterial vertexColors transparent opacity={0.34} blending={AdditiveBlending} depthWrite={false} />
      </lineSegments>
      <lineSegments ref={questionRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[questionPositions, 3]} />
          <bufferAttribute attach="attributes-color" args={[questionColors, 3]} />
        </bufferGeometry>
        <lineDashedMaterial vertexColors transparent opacity={0.5} dashSize={2} gapSize={1.5} depthWrite={false} />
      </lineSegments>
      <instancedMesh
        ref={meshRef}
        args={[undefined, undefined, nodes.length]}
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
      >
        <sphereGeometry args={[1, 16, 12]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={haloRef} args={[undefined, undefined, haloNodes.length]}>
        <sphereGeometry args={[1, 16, 12]} />
        <meshBasicMaterial
          color={nodeColor('foreshadow')}
          transparent
          opacity={0.14}
          blending={AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </instancedMesh>
      <instancedMesh ref={arrowRef} args={[undefined, undefined, directedEdges.length]}>
        <coneGeometry args={[0.72, 2.6, 8]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      {labelNodes.map((node) => (
        <Html
          key={`${node.id}-${settledVersion}`}
          position={[node.x, node.y, mode === 'local2d' ? 0 : node.z]}
          center
          distanceFactor={mode === 'local2d' ? 14 : 52}
          className={node.id === selectedNodeId ? 'graph-node-label active' : 'graph-node-label'}
          pointerEvents="none"
        >
          {node.data.name}
        </Html>
      ))}
      {bloom && (
        <EffectComposer multisampling={0}>
          <Bloom intensity={0.7} luminanceThreshold={0.35} mipmapBlur />
        </EffectComposer>
      )}
    </>
  );
}

export function GraphCanvas(props: GraphCanvasProps): React.JSX.Element {
  return (
    <div className="graph-canvas" aria-hidden="true">
      <Canvas
        frameloop="demand"
        dpr={[1, 1.5]}
        gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
        fallback={<CanvasFailure onUnavailable={props.onUnavailable} />}
      >
        <Scene {...props} />
      </Canvas>
    </div>
  );
}
