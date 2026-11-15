"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { computeIdlePose, agentFigureDims, agentPose, type AgentState, type AgentActivity } from "@diorama/engine";
import { ActivityIndicator3D } from "./ActivityIndicator3D";
import type { Group } from "three";

/** One shared set of proportions (engine/agentFigure.ts → AGENT_FIGURE_SCALE). */
const DIMS = agentFigureDims();

interface AgentFigure3DProps {
  state: AgentState;
  color: string;
  label: string;
  phase?: number;
  /** Energy level 0 (calm) to 1 (restless). Controls idle animation speed/intensity. */
  energy?: number;
  /** Current activity for visual indicator above head. */
  activity?: AgentActivity;
  /** Agent is blocked waiting for the user — shows the amber attention pill. */
  attention?: boolean;
  /** Label for the attention pill. */
  attentionLabel?: string;
  /** Click handler (selects the agent) */
  onClick?: () => void;
}

export function AgentFigure3D({
  state,
  color,
  label,
  phase = 0,
  energy = 0.5,
  activity = "idle",
  attention = false,
  attentionLabel,
  onClick,
}: AgentFigure3DProps) {
  const groupRef = useRef<Group>(null);
  const bodyRef = useRef<Group>(null);
  const leftLegRef = useRef<Group>(null);
  const rightLegRef = useRef<Group>(null);

  const seated = state.mode === "seated";
  const pose = agentPose(DIMS, seated, state.seatHeight);

  useFrame(({ clock }) => {
    if (!groupRef.current) return;

    // Position from agent state; seated agents face the way the seat faces
    groupRef.current.position.set(state.x, 0, state.z);
    groupRef.current.rotation.y = state.mode === "seated" && state.seatRotation != null ? state.seatRotation : state.facing;

    const t = clock.getElapsedTime();
    if (state.mode === "idle" || state.mode === "seated") {
      const idle = computeIdlePose(t, phase, energy);
      if (bodyRef.current) {
        bodyRef.current.position.x = idle.bodySwayX * DIMS.scale;
        bodyRef.current.position.z = idle.bodySwayZ * DIMS.scale;
        bodyRef.current.rotation.x = idle.torsoLean;
        bodyRef.current.rotation.y = idle.chairTurn;
      }
    }
    // Simple gait: legs swing while walking, rest otherwise
    const swing = state.mode === "walking" ? Math.sin(t * 9 + phase) * 0.55 : 0;
    if (leftLegRef.current) leftLegRef.current.rotation.x = swing;
    if (rightLegRef.current) rightLegRef.current.rotation.x = -swing;
  });

  const legMat = <meshStandardMaterial color={color} roughness={0.8} />;

  return (
    <group
      ref={groupRef}
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}
      onPointerOver={onClick ? () => { document.body.style.cursor = "pointer"; } : undefined}
      onPointerOut={onClick ? () => { document.body.style.cursor = ""; } : undefined}
    >
      {/* Activity indicator + name label above the head */}
      <group position={[0, pose.labelY, 0]}>
        <ActivityIndicator3D
          activity={activity}
          agentLabel={label}
          color={color}
          attention={attention}
          attentionLabel={attentionLabel}
        />
      </group>

      {/* Legs */}
      {seated ? (
        [-1, 1].map((side) => (
          <group key={side} position={[side * DIMS.legSpread, 0, 0]}>
            {/* thigh: horizontal, forward from the hips on the seat */}
            <mesh position={[0, pose.hipY + DIMS.legRadius, DIMS.thighLength / 2]} rotation={[Math.PI / 2, 0, 0]}>
              <capsuleGeometry args={[DIMS.legRadius, DIMS.thighLength, 4, 10]} />
              {legMat}
            </mesh>
            {/* shin: from the knee down to the floor */}
            <mesh position={[0, (pose.hipY + DIMS.legRadius) / 2, DIMS.thighLength]}>
              <capsuleGeometry args={[DIMS.legRadius, Math.max(0.01, pose.hipY - DIMS.legRadius), 4, 10]} />
              {legMat}
            </mesh>
          </group>
        ))
      ) : (
        <>
          <group ref={leftLegRef} position={[-DIMS.legSpread, pose.hipY, 0]}>
            <mesh position={[0, -DIMS.legLength / 2, 0]}>
              <capsuleGeometry args={[DIMS.legRadius, DIMS.legLength - 2 * DIMS.legRadius, 4, 10]} />
              {legMat}
            </mesh>
          </group>
          <group ref={rightLegRef} position={[DIMS.legSpread, pose.hipY, 0]}>
            <mesh position={[0, -DIMS.legLength / 2, 0]}>
              <capsuleGeometry args={[DIMS.legRadius, DIMS.legLength - 2 * DIMS.legRadius, 4, 10]} />
              {legMat}
            </mesh>
          </group>
        </>
      )}

      <group ref={bodyRef}>
        {/* Torso — capsule, bottom on the hips */}
        <mesh position={[0, pose.torsoY, 0]}>
          <capsuleGeometry args={[DIMS.torsoRadius, DIMS.torsoLength, 8, 16]} />
          <meshStandardMaterial color={color} />
        </mesh>

        {/* Head */}
        <mesh position={[0, pose.headY, 0]}>
          <sphereGeometry args={[DIMS.headRadius, 16, 16]} />
          <meshStandardMaterial color={color} />
        </mesh>

        {/* Badge glow (front = +z) */}
        <mesh position={[0, pose.badgeY, DIMS.torsoRadius + DIMS.badgeRadius * 0.25]}>
          <sphereGeometry args={[DIMS.badgeRadius, 8, 8]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={1} />
        </mesh>
      </group>
    </group>
  );
}
