import { useEffect, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import EmergencyNavbar from "../components/EmergencyNavbar";
import { db, auth } from "../firebase";
import {
  doc,
  setDoc,
  serverTimestamp,
  collection,
  addDoc,
  getDocs,
} from "firebase/firestore";

import {
  MapContainer,
  TileLayer,
  Marker,
  Circle,
  Popup,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";

/* ✅ NAMED IMPORT (FIXED) */
import { qrAgent } from "../rl/qrAgent";

import "./UserHome.css";

/* ICONS */
import {
  HiShieldCheck,
  HiExclamationTriangle,
  HiMapPin,
} from "react-icons/hi2";
import { MdMyLocation, MdFeedback } from "react-icons/md";
import { FaRoute } from "react-icons/fa";

/* FIX LEAFLET ICONS */
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

/* DISTANCE UTILS */
const getDistanceMeters = (lat1, lon1, lat2, lon2) => {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const metersToText = (m) => {
  if (m == null) return "--";
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(2)} km`;
};

const UserHome = () => {
  const navigate = useNavigate();

  /* STATE */
  const [userLoc, setUserLoc] = useState(null);
  const [riskZones, setRiskZones] = useState([]);
  const [safeZones, setSafeZones] = useState([]);
  const [loadingZones, setLoadingZones] = useState(true);

  const [inRisk, setInRisk] = useState(false);
  const [activeRiskZone, setActiveRiskZone] = useState(null);

  const [feedbackType, setFeedbackType] = useState("Issue");
  const [feedbackMsg, setFeedbackMsg] = useState("");
  const [sending, setSending] = useState(false);

  const [tracking, setTracking] = useState(false);

  const watchIdRef = useRef(null);
  const intervalRef = useRef(null);
  const lastSentRef = useRef(0);

  /* LOAD ZONES */
  useEffect(() => {
    const loadZones = async () => {
      try {
        const [riskSnap, safeSnap] = await Promise.all([
          getDocs(collection(db, "riskZones")),
          getDocs(collection(db, "safeZones")),
        ]);

        setRiskZones(
          riskSnap.docs
            .map((d) => ({ id: d.id, ...d.data() }))
            .filter((z) => z.active)
        );

        setSafeZones(
          safeSnap.docs
            .map((d) => ({ id: d.id, ...d.data() }))
            .filter((z) => z.active)
        );
      } catch (e) {
        console.error(e);
      } finally {
        setLoadingZones(false);
      }
    };

    loadZones();
  }, []);

  /* LOCATION TRACKING */
  const startLocationTracking = () => {
    if (!navigator.geolocation) return;

    setTracking(true);
    const uid = auth.currentUser?.uid || "guest";

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        setUserLoc({ latitude, longitude });

        let danger = false;
        let matched = null;

        for (const z of riskZones) {
          const d = getDistanceMeters(latitude, longitude, z.latitude, z.longitude);
          if (d <= z.radius) {
            danger = true;
            matched = z;
            break;
          }
        }

        setInRisk(danger);
        setActiveRiskZone(matched);
      },
      () => {
        alert("Location permission denied");
        setTracking(false);
      },
      { enableHighAccuracy: true }
    );

    intervalRef.current = setInterval(async () => {
      if (!userLoc) return;
      const now = Date.now();
      if (now - lastSentRef.current > 15000) {
        lastSentRef.current = now;
        await setDoc(
          doc(db, "liveUsers", uid),
          { ...userLoc, updatedAt: serverTimestamp() },
          { merge: true }
        );
      }
    }, 15000);
  };

  useEffect(() => {
    return () => {
      if (watchIdRef.current)
        navigator.geolocation.clearWatch(watchIdRef.current);
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  /* SAFE ZONE LOGIC */
  const relatedSafeZones =
    userLoc && activeRiskZone
      ? safeZones.filter(
          (s) =>
            s.riskZoneId === activeRiskZone.id ||
            getDistanceMeters(
              userLoc.latitude,
              userLoc.longitude,
              s.latitude,
              s.longitude
            ) <= 5000
        )
      : [];

  let selectedSafeZone = null;

  try {
    if (userLoc && relatedSafeZones.length > 0) {
      selectedSafeZone = qrAgent(userLoc, relatedSafeZones);
    }
  } catch {
    selectedSafeZone = null;
  }

  const distanceToSafeZone =
    userLoc && selectedSafeZone
      ? getDistanceMeters(
          userLoc.latitude,
          userLoc.longitude,
          selectedSafeZone.latitude,
          selectedSafeZone.longitude
        )
      : null;

  /* FEEDBACK */
  const submitFeedback = async () => {
    if (!feedbackMsg.trim()) return;
    setSending(true);
    await addDoc(collection(db, "feedbackReports"), {
      type: feedbackType,
      message: feedbackMsg,
      createdAt: serverTimestamp(),
    });
    setFeedbackMsg("");
    setSending(false);
    alert("Feedback submitted");
  };

  return (
    <div className="page">
      <EmergencyNavbar />

      <main className="main-container">
        {loadingZones && <p style={{ textAlign: "center" }}>Initializing…</p>}

        <div className="hero">
          <h1 className="hero-title">
            <HiShieldCheck /> Safe Zone Monitoring
          </h1>

          {!tracking && (
            <button className="navigate-btn" onClick={startLocationTracking}>
              <MdMyLocation /> Enable Location Access
            </button>
          )}
        </div>

        <div className="grid-2">
          <div className="card">
            <h2 className="card-title">
              <HiMapPin /> Status
            </h2>
            {inRisk ? "Inside Risk Zone" : "Safe Area"}
          </div>

          <div className="card">
            <h2 className="card-title">
              <HiShieldCheck /> Nearest Safe Zone
            </h2>
            {selectedSafeZone
              ? metersToText(distanceToSafeZone)
              : "No safe zone"}
          </div>
        </div>

        {userLoc && activeRiskZone && (
          <div className="card" style={{ marginTop: 30 }}>
            <MapContainer
              center={[userLoc.latitude, userLoc.longitude]}
              zoom={14}
              style={{ height: 320 }}
            >
              <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
              <Circle
                center={[activeRiskZone.latitude, activeRiskZone.longitude]}
                radius={activeRiskZone.radius}
                pathOptions={{ color: "red" }}
              />
              <Marker position={[userLoc.latitude, userLoc.longitude]}>
                <Popup>You are here</Popup>
              </Marker>
            </MapContainer>

            {selectedSafeZone && (
              <button
                className="navigate-btn"
                onClick={() =>
                  navigate(
                    `/navigate?slat=${selectedSafeZone.latitude}&slng=${selectedSafeZone.longitude}`
                  )
                }
              >
                <FaRoute /> Navigate
              </button>
            )}
          </div>
        )}

        <div className="card" style={{ marginTop: 30 }}>
          <h2 className="card-title">
            <MdFeedback /> Feedback
          </h2>

          <select
            value={feedbackType}
            onChange={(e) => setFeedbackType(e.target.value)}
          >
            <option value="Issue">Issue</option>
            <option value="Suggestion">Suggestion</option>
            <option value="Experience">Experience</option>
          </select>

          <textarea
            value={feedbackMsg}
            onChange={(e) => setFeedbackMsg(e.target.value)}
            placeholder="Write feedback…"
          />

          <button
            className="navigate-btn"
            onClick={submitFeedback}
            disabled={sending}
          >
            {sending ? "Submitting…" : "Submit"}
          </button>
        </div>
      </main>
    </div>
  );
};

export default UserHome;
