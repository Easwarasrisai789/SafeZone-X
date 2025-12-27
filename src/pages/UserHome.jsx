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

  /* FETCH ZONES (OPTIMIZED – NO REALTIME LISTENERS) */
  const loadZones = async () => {
    try {
      setLoadingZones(true);

      const riskSnap = await getDocs(collection(db, "riskZones"));
      const safeSnap = await getDocs(collection(db, "safeZones"));

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
      console.error("Zone load error:", e);
    } finally {
      setLoadingZones(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(loadZones, 1500); // lazy load
    return () => clearTimeout(timer);
  }, []);

  /* START LOCATION TRACKING */
  const startLocationTracking = () => {
    if (!navigator.geolocation) return alert("Geolocation not supported");

    setTracking(true);
    const uid = auth.currentUser?.uid || "guest";

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        const loc = { latitude, longitude };
        setUserLoc(loc);

        let danger = false;
        let matchedZone = null;

        for (const zone of riskZones) {
          const d = getDistanceMeters(
            latitude,
            longitude,
            zone.latitude,
            zone.longitude
          );
          if (d <= zone.radius) {
            danger = true;
            matchedZone = zone;
            break;
          }
        }

        setInRisk(danger);
        setActiveRiskZone(matchedZone);
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

  let selectedSafeZone = qrAgent(userLoc, relatedSafeZones);

  if (!selectedSafeZone && userLoc && relatedSafeZones.length > 0) {
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

  /* FEEDBACK */
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

  return (
    <div className="page">
      <EmergencyNavbar />

      <main className="main-container">
        {loadingZones && (
          <div style={{ textAlign: "center", marginTop: 30 }}>
            Loading Safe & Risk Zones...
          </div>
        )}

        {/* 🔽 REST OF YOUR JSX REMAINS SAME 🔽 */}
      </main>
    </div>
  );
};

export default UserHome;
