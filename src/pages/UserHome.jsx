import { useEffect, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import EmergencyNavbar from "../components/EmergencyNavbar";
import ErrorBoundary from "../components/ErrorBoundary";
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

  /* ---------------- STATE ---------------- */
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

  /* ---------------- LOAD ZONES ---------------- */
  const loadZones = async () => {
    try {
      setLoadingZones(true);

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
    } catch (err) {
      console.error("Zone loading failed:", err);
    } finally {
      setLoadingZones(false);
    }
  };

  useEffect(() => {
    const t = setTimeout(loadZones, 1200);
    return () => clearTimeout(t);
  }, []);

  /* ---------------- LOCATION TRACKING ---------------- */
  const startLocationTracking = () => {
    if (!navigator.geolocation) {
      alert("Geolocation not supported");
      return;
    }

    setTracking(true);
    const uid = auth.currentUser?.uid || "guest";

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        setUserLoc({ latitude, longitude });

        if (!riskZones.length) return;

        let danger = false;
        let matched = null;

        for (const zone of riskZones) {
          const d = getDistanceMeters(
            latitude,
            longitude,
            zone.latitude,
            zone.longitude
          );
          if (d <= zone.radius) {
            danger = true;
            matched = zone;
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
      if (now - lastSentRef.current >= 15000) {
        lastSentRef.current = now;
        await setDoc(
          doc(db, "liveUsers", uid),
          {
            latitude: userLoc.latitude,
            longitude: userLoc.longitude,
            status: "ACTIVE",
            updatedAt: serverTimestamp(),
          },
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

  /* ---------------- SAFE ZONE LOGIC (GUARDED) ---------------- */
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
    if (
      userLoc &&
      activeRiskZone &&
      Array.isArray(relatedSafeZones) &&
      relatedSafeZones.length > 0
    ) {
      selectedSafeZone = qrAgent(userLoc, relatedSafeZones);
    }
  } catch (err) {
    console.error("qrAgent crashed safely:", err);
    selectedSafeZone = null;
  }

  if (
    !selectedSafeZone &&
    userLoc &&
    Array.isArray(relatedSafeZones) &&
    relatedSafeZones.length > 0
  ) {
    selectedSafeZone = relatedSafeZones.reduce((nearest, z) => {
      const d1 = getDistanceMeters(
        userLoc.latitude,
        userLoc.longitude,
        z.latitude,
        z.longitude
      );
      const d2 = nearest
        ? getDistanceMeters(
            userLoc.latitude,
            userLoc.longitude,
            nearest.latitude,
            nearest.longitude
          )
        : Infinity;
      return d1 < d2 ? z : nearest;
    }, null);
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

  /* ---------------- FEEDBACK ---------------- */
  const submitFeedback = async () => {
    if (!feedbackMsg.trim()) return alert("Enter feedback");
    try {
      setSending(true);
      await addDoc(collection(db, "feedbackReports"), {
        uid: auth.currentUser?.uid || "anonymous",
        type: feedbackType,
        message: feedbackMsg,
        createdAt: serverTimestamp(),
      });
      setFeedbackMsg("");
      alert("Thank you for your feedback");
    } finally {
      setSending(false);
    }
  };

  /* ---------------- UI ---------------- */
  return (
    <div className="page">
      <EmergencyNavbar />

      <ErrorBoundary>
        <main className="main-container">
          {loadingZones && (
            <div
              style={{
                background: "#fef3c7",
                color: "#92400e",
                padding: "12px",
                borderRadius: "12px",
                marginBottom: "20px",
                textAlign: "center",
              }}
            >
              Initializing Safe & Risk Zones…
            </div>
          )}

          <div className="hero">
            <h1 className="hero-title">
              <HiShieldCheck /> Safe Zone Monitoring
            </h1>
            <p className="hero-text">
              Live emergency monitoring and navigation assistance
            </p>

            {!tracking && (
              <button className="navigate-btn" onClick={startLocationTracking}>
                <MdMyLocation /> Enable Location Access
              </button>
            )}
          </div>

          <div className="grid-2">
            <div className="card">
              <h2 className="card-title">
                <HiMapPin /> Current Status
              </h2>

              {inRisk ? (
                <div className="risk-alert">
                  <HiExclamationTriangle /> Inside Risk Zone
                </div>
              ) : (
                <div className="safe-alert">
                  <HiShieldCheck /> Safe Area
                </div>
              )}

              <p><b>Risk Zone:</b> {activeRiskZone?.name || "None"}</p>
            </div>

            <div className="card">
              <h2 className="card-title">
                <HiShieldCheck /> Nearest Safe Zone
              </h2>

              {selectedSafeZone ? (
                <p><b>Distance:</b> {metersToText(distanceToSafeZone)}</p>
              ) : (
                <p>No safe zone available</p>
              )}
            </div>
          </div>

          {tracking &&
            inRisk &&
            userLoc?.latitude &&
            userLoc?.longitude &&
            activeRiskZone?.latitude &&
            activeRiskZone?.longitude && (
              <div className="card" style={{ marginTop: "40px" }}>
                <MapContainer
                  center={[userLoc.latitude, userLoc.longitude]}
                  zoom={14}
                  style={{ height: "340px", width: "100%" }}
                >
                  <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />

                  <Circle
                    center={[
                      activeRiskZone.latitude,
                      activeRiskZone.longitude,
                    ]}
                    radius={activeRiskZone.radius}
                    pathOptions={{ color: "red", fillOpacity: 0.25 }}
                  />

                  {relatedSafeZones.map((z) => (
                    <Circle
                      key={z.id}
                      center={[z.latitude, z.longitude]}
                      radius={z.radius}
                      pathOptions={{ color: "green", fillOpacity: 0.35 }}
                    />
                  ))}

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
                    <FaRoute /> Start Emergency Navigation
                  </button>
                )}
              </div>
            )}

          <div className="card" style={{ marginTop: "40px" }}>
            <h2 className="card-title">
              <MdFeedback /> Feedback & Suggestions
            </h2>

            <select
              value={feedbackType}
              onChange={(e) => setFeedbackType(e.target.value)}
            >
              <option value="Issue">Report an Issue</option>
              <option value="Suggestion">Suggest Improvement</option>
              <option value="Experience">Share Experience</option>
            </select>

            <textarea
              value={feedbackMsg}
              onChange={(e) => setFeedbackMsg(e.target.value)}
              placeholder="Describe your feedback..."
              rows={4}
            />

            <button
              className="navigate-btn"
              onClick={submitFeedback}
              disabled={sending}
            >
              {sending ? "Submitting..." : "Submit Feedback"}
            </button>
          </div>
        </main>
      </ErrorBoundary>
    </div>
  );
};

export default UserHome;
