"""
python_backend/main.py
FastAPI microservice — port 8000
  POST /deepfake      — DeepFace + OpenCV image manipulation detection
  POST /ml-classify   — TF-IDF + Logistic Regression fake news classifier
  GET  /health        — service health check
"""

import os
import io
import base64
import logging
import pickle
import re
import random
from pathlib import Path
from contextlib import asynccontextmanager

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s")
log = logging.getLogger(__name__)

# ── Paths ─────────────────────────────────────────────────────────────────────
BASE_DIR   = Path(__file__).parent
MODEL_PATH = BASE_DIR / "ml_model.pkl"

# ── ML model (loaded at startup) ──────────────────────────────────────────────
_ml_pipeline = None   # sklearn Pipeline: TfidfVectorizer + LogisticRegression


# ── Train or load model ───────────────────────────────────────────────────────

def _train_or_load_model():
    global _ml_pipeline
    from sklearn.pipeline import Pipeline
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.linear_model import LogisticRegression

    if MODEL_PATH.exists():
        log.info("Loading ML model from disk…")
        with open(MODEL_PATH, "rb") as f:
            _ml_pipeline = pickle.load(f)
        log.info("ML model loaded ✓")
        return

    log.info("Training ML model on synthetic dataset…")

    fake_samples = [
        "BREAKING: Government secretly distributing free money to all citizens register now",
        "SHOCKING: Scientists discover miracle cure for all diseases hidden by Big Pharma",
        "URGENT: Forward this message before midnight to claim your free smartphone",
        "LEAKED: Secret documents reveal government plan to control population via 5G",
        "WARNING: New law will ban all private bank accounts share this immediately",
        "Vaccines contain microchips that track your location via Bluetooth technology",
        "Bill Gates is funding population reduction through coronavirus vaccines",
        "COVID-19 was created in a lab as a bioweapon to control world governments",
        "Free laptops being distributed to all students under 25 by government register",
        "Government depositing Rs 15 lakh in every Indian citizen bank account apply now",
        "CONFIRMED: Celebrity found dead in mysterious circumstances they are hiding truth",
        "Must share: This simple trick cures diabetes in 3 days doctors don't want you to know",
        "ALERT: WhatsApp will start charging users unless you forward this to 10 friends",
        "Shocking revelation: Moon landing was faked in Hollywood studio by NASA",
        "Breaking news exclusive: Famous politician caught taking bribes leaked video",
        "Emergency alert: Earthquake predicted tomorrow evacuate coastal areas immediately",
        "Secret government scheme gives free gold to all families apply before election",
        "They don't want you to know this one food that kills cancer cells overnight",
        "Urgent forward: New virus more deadly than COVID spreading share to warn family",
        "Guaranteed investment scheme 40 percent returns monthly limited time offer",
        "New currency notes contain GPS chips to track black money holders",
        "Jio SIM cards secretly record all your conversations for government surveillance",
        "Free recharge offer share this link with 10 friends to get 1 year free data",
        "Government hiding cure for cancer to keep pharmaceutical companies profitable",
        "SHOCKING leaked audio proves top minister involved in major corruption scandal",
        "5G towers are causing COVID-19 by spreading the virus through radio waves",
        "Drinking bleach cures coronavirus must share before they delete this",
        "All citizens will receive free ration cards forward this to claim yours",
        "Secret elite group controls all world governments and media exposed",
        "Miracle herb banned by doctors cures all chronic diseases in 7 days",
    ]

    real_samples = [
        "The Reserve Bank of India raised the repo rate by 25 basis points on Wednesday",
        "Supreme Court upheld the constitutional validity of the electoral bonds scheme",
        "India GDP grew at 7.2 percent in the second quarter according to official data",
        "Prime Minister held bilateral talks with the US President on trade and defence",
        "Heavy rainfall forecast for Maharashtra and Gujarat over the next 48 hours",
        "Parliament passed the new data protection bill after three readings in both houses",
        "ISRO successfully launched the satellite into geosynchronous transfer orbit",
        "Finance Minister presented the Union Budget with focus on infrastructure spending",
        "Election Commission announced schedule for state assembly elections in five states",
        "New education policy implementation begins in universities across the country",
        "Stock markets closed higher with Sensex gaining 450 points in Tuesday session",
        "Government launches new health insurance scheme for workers in unorganised sector",
        "Police arrested three suspects in connection with the bank robbery case in Mumbai",
        "Monsoon arrived in Kerala two days ahead of the normal date this year",
        "India signed a free trade agreement with the European Union after years of talks",
        "Central government approved construction of new expressway connecting major cities",
        "Scientists at IIT developed a low-cost water purification technology for rural use",
        "Railway ministry announced new express trains on high-demand routes across India",
        "High court ordered investigation into alleged irregularities in land allotment case",
        "State government announced increase in minimum support price for wheat and rice",
        "Defence ministry signed contract for procurement of fighter aircraft from France",
        "Municipal corporation launched drive to improve solid waste management in city",
        "Report highlights need for improved road safety measures across national highways",
        "Central bank issued new guidelines for digital payment security and fraud prevention",
        "University released results for annual examinations on official website today",
        "Cabinet approved new scheme to provide drinking water to rural households",
        "Health ministry issued advisory on seasonal flu precautions for vulnerable groups",
        "Census data shows improvement in literacy rate across most Indian states",
        "Government allocated funds for construction of new AIIMS hospitals in five cities",
        "Trade deficit narrowed in October due to higher exports and lower gold imports",
    ]

    augmented_fake = fake_samples * 10
    augmented_real = real_samples * 10

    texts  = augmented_fake + augmented_real
    labels = [1] * len(augmented_fake) + [0] * len(augmented_real)

    combined = list(zip(texts, labels))
    random.seed(42)
    random.shuffle(combined)
    texts, labels = zip(*combined)

    _ml_pipeline = Pipeline([
        ("tfidf", TfidfVectorizer(
            ngram_range=(1, 3),
            max_features=15000,
            sublinear_tf=True,
            strip_accents="unicode",
            analyzer="word",
            min_df=1,
        )),
        ("clf", LogisticRegression(
            max_iter=1000,
            C=1.5,
            solver="lbfgs",
            random_state=42,
        )),
    ])
    _ml_pipeline.fit(list(texts), list(labels))

    with open(MODEL_PATH, "wb") as f:
        pickle.dump(_ml_pipeline, f)

    log.info("ML model trained and saved ✓")


# ── Lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("Starting up Python microservice…")
    _train_or_load_model()
    log.info("Python microservice ready ✓")
    yield
    log.info("Shutting down…")


# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(title="Credible Chronicles — Python ML Service", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Request models ─────────────────────────────────────────────────────────────

class DeepfakeRequest(BaseModel):
    imageBase64: str
    mimeType: str = "image/jpeg"

class MLRequest(BaseModel):
    claim: str


# ── Image analysis helpers ────────────────────────────────────────────────────

def _decode_image(b64: str) -> np.ndarray:
    data = base64.b64decode(b64)
    arr  = np.frombuffer(data, dtype=np.uint8)
    img  = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image — unsupported format or corrupt data")
    return img


def _ela_score(img: np.ndarray) -> float:
    """Error Level Analysis — higher score = more likely manipulated (0–100)."""
    _, encoded   = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 75])
    compressed   = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    diff         = cv2.absdiff(img, compressed).astype(np.float32)
    return min(float(np.mean(diff) * 10), 100.0)


def _noise_score(img: np.ndarray) -> float:
    """Inconsistent noise pattern detection — higher = more suspicious (0–100)."""
    gray    = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
    blur    = cv2.GaussianBlur(gray, (5, 5), 0)
    noise   = gray - blur
    std_dev = float(np.std(noise))
    return min(std_dev * 2.5, 100.0)


def _metadata_flags(img: np.ndarray) -> list:
    """Structural checks for suspicious image properties."""
    flags = []
    h, w  = img.shape[:2]

    if w > 4000 or h > 4000:
        flags.append("Unusually high resolution — may indicate AI generation")
    if w == h:
        flags.append("Perfect square aspect ratio — common in AI-generated images")

    gray    = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    lap_var = cv2.Laplacian(gray, cv2.CV_64F).var()
    if lap_var < 20:
        flags.append("Very low sharpness variance — possible cloning or blur manipulation")

    b, g, r      = cv2.split(img)
    channel_std  = float(np.std([b.mean(), g.mean(), r.mean()]))
    if channel_std > 40:
        flags.append("Unusual colour channel imbalance — possible filter or splice")

    return flags


def _face_analysis(img: np.ndarray) -> dict:
    """Run DeepFace analysis — degrades gracefully if no face or package missing."""
    try:
        from deepface import DeepFace  # type: ignore
        results = DeepFace.analyze(
            img_path          = img,
            actions           = ["age", "gender", "emotion"],
            enforce_detection = False,
            silent            = True,
        )
        if isinstance(results, list):
            results = results[0]
        return {
            "face_detected":  True,
            "age":            results.get("age"),
            "gender":         results.get("dominant_gender"),
            "emotion":        results.get("dominant_emotion"),
            "emotion_scores": results.get("emotion", {}),
        }
    except ImportError:
        return {"face_detected": False, "reason": "DeepFace not installed"}
    except Exception as e:
        log.debug("DeepFace: %s", e)
        return {"face_detected": False, "reason": "No face detected"}


def _manipulation_score(ela: float, noise: float, flags: list) -> float:
    return round(min((ela * 0.45) + (noise * 0.35) + (len(flags) * 5), 100.0), 1)


def _manipulation_label(score: float) -> str:
    if score >= 70: return "Likely Manipulated"
    if score >= 45: return "Possibly Manipulated"
    if score >= 25: return "Low Manipulation Signs"
    return "Likely Authentic"


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    try:
        import sklearn; sklearn_ok = True    # noqa: E401
    except ImportError:
        sklearn_ok = False
    try:
        import deepface; deepface_ok = True  # noqa: E401
    except ImportError:
        deepface_ok = False

    return {
        "status":        "ok",
        "model_trained": MODEL_PATH.exists(),
        "services": {
            "opencv":   True,
            "sklearn":  sklearn_ok,
            "deepface": deepface_ok,
        },
    }


@app.post("/deepfake")
async def deepfake_detect(req: DeepfakeRequest):
    if not req.imageBase64:
        raise HTTPException(400, "imageBase64 required")
    try:
        img = _decode_image(req.imageBase64)
    except Exception as e:
        raise HTTPException(400, f"Image decode failed: {e}")

    ela   = _ela_score(img)
    noise = _noise_score(img)
    flags = _metadata_flags(img)
    faces = _face_analysis(img)
    score = _manipulation_score(ela, noise, flags)
    label = _manipulation_label(score)
    h, w  = img.shape[:2]

    return {
        "manipulation_score": score,
        "label":              label,
        "confidence":         round(100 - abs(score - 50), 1),
        "signals": {
            "ela_score":   round(ela, 1),
            "noise_score": round(noise, 1),
            "flags":       flags,
        },
        "face_analysis":  faces,
        "image_metadata": {"width": w, "height": h, "aspect": round(w / h, 2)},
    }


@app.post("/ml-classify")
async def ml_classify(req: MLRequest):
    if not req.claim or not req.claim.strip():
        raise HTTPException(400, "claim required")
    if _ml_pipeline is None:
        raise HTTPException(503, "ML model not loaded yet — try again shortly")

    claim = req.claim.strip()[:2000]
    proba     = _ml_pipeline.predict_proba([claim])[0]
    fake_prob = round(float(proba[1]) * 100, 1)
    real_prob = round(float(proba[0]) * 100, 1)
    confidence= round(max(fake_prob, real_prob), 1)

    label = (
        "Likely Fake"         if fake_prob >= 70 else
        "Possibly Misleading" if fake_prob >= 45 else
        "Needs Verification"  if fake_prob >= 30 else
        "Likely Real"
    )

    # Top features pushing toward fake
    try:
        vec        = _ml_pipeline.named_steps["tfidf"]
        clf        = _ml_pipeline.named_steps["clf"]
        features   = vec.get_feature_names_out()
        tfidf_vec  = vec.transform([claim])
        coefs      = clf.coef_[0]
        nonzero    = tfidf_vec.nonzero()[1]
        scored     = [(features[i], float(coefs[i] * tfidf_vec[0, i])) for i in nonzero]
        top_signals= [f for f, s in sorted(scored, key=lambda x: -x[1])[:5] if s > 0]
    except Exception:
        top_signals = []

    return {
        "fake_probability":  fake_prob,
        "real_probability":  real_prob,
        "confidence":        confidence,
        "label":             label,
        "top_fake_signals":  top_signals,
        "model":             "TF-IDF + Logistic Regression (local)",
    }