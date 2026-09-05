"use client";

import { ChangePassword } from "./ChangePassword";

import { useState, useEffect, useRef, useCallback, useId } from "react";
import Image from "next/image";
import { useUserId } from "@/lib/hooks/useUserId";
import { useUserProfile } from "@/lib/context/UserProfileContext";
import {
    updateProfile,
    type UserProfile,
    type ProfileUpdatePayload,
} from "@/lib/api/profile";

// ── Occupation options ───────────────────────────────────────

const OCCUPATION_OPTIONS = [
    "Select",
    "Computer Science Student",
    "Software Engineering Student",
    "IT Student",
    "Data Science Student",
    "Cybersecurity Student",
    "Design Student",
    "Business Student",
    "Other Student",
    "Software Engineer",
    "Data Analyst",
    "Researcher",
    "Educator",
    "Other",
];

// ─────────────────────────────────────────────────────────────
// AvatarCropModal — built-in drag + zoom crop, no external lib
// ─────────────────────────────────────────────────────────────

interface CropState {
    x: number; // offset from centre, in px on the source image
    y: number;
    zoom: number; // 1 = fit-to-circle, >1 = zoomed in
}

function AvatarCropModal({
    src,
    onApply,
    onCancel,
}: {
    src: string;
    onApply: (dataUrl: string) => void;
    onCancel: () => void;
}) {
    const OUTPUT_SIZE = 300; // final canvas px
    const PREVIEW_SIZE = 280; // modal preview circle px

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const imgRef = useRef<HTMLImageElement | null>(null);
    const isDragging = useRef(false);
    const dragStart = useRef({ x: 0, y: 0 });
    const cropRef = useRef<CropState>({ x: 0, y: 0, zoom: 1 });

    const [crop, setCrop] = useState<CropState>({ x: 0, y: 0, zoom: 1 });
    const [imgLoaded, setImgLoaded] = useState(false);

    // Draw the preview canvas whenever crop changes
    const draw = useCallback((state: CropState) => {
        const canvas = canvasRef.current;
        const img = imgRef.current;
        if (!canvas || !img || !img.complete) return;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const iw = img.naturalWidth;
        const ih = img.naturalHeight;

        // The "base" scale makes the shorter side fill the preview circle
        const baseScale = PREVIEW_SIZE / Math.min(iw, ih);
        const scale = baseScale * state.zoom;

        // Scaled image dimensions
        const sw = iw * scale;
        const sh = ih * scale;

        // Draw offset: centre + user drag offset (clamped)
        const maxOffX = (sw - PREVIEW_SIZE) / 2;
        const maxOffY = (sh - PREVIEW_SIZE) / 2;
        const ox = Math.max(-maxOffX, Math.min(maxOffX, state.x));
        const oy = Math.max(-maxOffY, Math.min(maxOffY, state.y));

        const drawX = (PREVIEW_SIZE - sw) / 2 + ox;
        const drawY = (PREVIEW_SIZE - sh) / 2 + oy;

        ctx.clearRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
        ctx.drawImage(img, drawX, drawY, sw, sh);
    }, []);

    // Load image once
    useEffect(() => {
        const img = new window.Image();
        img.onload = () => {
            imgRef.current = img;
            setImgLoaded(true);
        };
        img.src = src;
    }, [src]);

    useEffect(() => {
        if (imgLoaded) draw(crop);
    }, [crop, imgLoaded, draw]);

    // ── Drag handlers ────────────────────────────────────────

    const onMouseDown = (e: React.MouseEvent) => {
        isDragging.current = true;
        dragStart.current = { x: e.clientX - cropRef.current.x, y: e.clientY - cropRef.current.y };
        e.preventDefault();
    };

    const onMouseMove = useCallback((e: MouseEvent) => {
        if (!isDragging.current) return;
        const img = imgRef.current;
        if (!img) return;

        const iw = img.naturalWidth;
        const ih = img.naturalHeight;
        const baseScale = PREVIEW_SIZE / Math.min(iw, ih);
        const scale = baseScale * cropRef.current.zoom;
        const sw = iw * scale;
        const sh = ih * scale;
        const maxOffX = (sw - PREVIEW_SIZE) / 2;
        const maxOffY = (sh - PREVIEW_SIZE) / 2;

        const nx = Math.max(-maxOffX, Math.min(maxOffX, e.clientX - dragStart.current.x));
        const ny = Math.max(-maxOffY, Math.min(maxOffY, e.clientY - dragStart.current.y));

        cropRef.current = { ...cropRef.current, x: nx, y: ny };
        setCrop((prev) => ({ ...prev, x: nx, y: ny }));
    }, []);

    const onMouseUp = useCallback(() => {
        isDragging.current = false;
    }, []);

    useEffect(() => {
        window.addEventListener("mousemove", onMouseMove);
        window.addEventListener("mouseup", onMouseUp);
        return () => {
            window.removeEventListener("mousemove", onMouseMove);
            window.removeEventListener("mouseup", onMouseUp);
        };
    }, [onMouseMove, onMouseUp]);

    // ── Touch handlers ───────────────────────────────────────

    const onTouchStart = (e: React.TouchEvent) => {
        isDragging.current = true;
        const t = e.touches[0];
        dragStart.current = { x: t.clientX - cropRef.current.x, y: t.clientY - cropRef.current.y };
    };

    const onTouchMove = useCallback((e: TouchEvent) => {
        if (!isDragging.current) return;
        const t = e.touches[0];
        const img = imgRef.current;
        if (!img) return;

        const iw = img.naturalWidth;
        const ih = img.naturalHeight;
        const baseScale = PREVIEW_SIZE / Math.min(iw, ih);
        const scale = baseScale * cropRef.current.zoom;
        const sw = iw * scale;
        const sh = ih * scale;
        const maxOffX = (sw - PREVIEW_SIZE) / 2;
        const maxOffY = (sh - PREVIEW_SIZE) / 2;

        const nx = Math.max(-maxOffX, Math.min(maxOffX, t.clientX - dragStart.current.x));
        const ny = Math.max(-maxOffY, Math.min(maxOffY, t.clientY - dragStart.current.y));

        cropRef.current = { ...cropRef.current, x: nx, y: ny };
        setCrop((prev) => ({ ...prev, x: nx, y: ny }));
        e.preventDefault();
    }, []);

    const onTouchEnd = useCallback(() => {
        isDragging.current = false;
    }, []);

    useEffect(() => {
        window.addEventListener("touchmove", onTouchMove, { passive: false });
        window.addEventListener("touchend", onTouchEnd);
        return () => {
            window.removeEventListener("touchmove", onTouchMove);
            window.removeEventListener("touchend", onTouchEnd);
        };
    }, [onTouchMove, onTouchEnd]);

    // ── Zoom slider ──────────────────────────────────────────

    const handleZoom = (e: React.ChangeEvent<HTMLInputElement>) => {
        const zoom = parseFloat(e.target.value);
        cropRef.current = { ...cropRef.current, zoom };
        setCrop((prev) => ({ ...prev, zoom }));
    };

    // ── Apply: render to OUTPUT_SIZE canvas → WebP base64 ───

    const handleApply = () => {
        const img = imgRef.current;
        if (!img) return;

        const out = document.createElement("canvas");
        out.width = OUTPUT_SIZE;
        out.height = OUTPUT_SIZE;
        const ctx = out.getContext("2d");
        if (!ctx) return;

        const iw = img.naturalWidth;
        const ih = img.naturalHeight;
        const baseScale = PREVIEW_SIZE / Math.min(iw, ih);
        const scale = baseScale * cropRef.current.zoom;
        const sw = iw * scale;
        const sh = ih * scale;
        const maxOffX = (sw - PREVIEW_SIZE) / 2;
        const maxOffY = (sh - PREVIEW_SIZE) / 2;
        const ox = Math.max(-maxOffX, Math.min(maxOffX, cropRef.current.x));
        const oy = Math.max(-maxOffY, Math.min(maxOffY, cropRef.current.y));
        const drawX = (PREVIEW_SIZE - sw) / 2 + ox;
        const drawY = (PREVIEW_SIZE - sh) / 2 + oy;

        // Scale draw coordinates from preview → output canvas
        const ratio = OUTPUT_SIZE / PREVIEW_SIZE;
        ctx.drawImage(img, drawX * ratio, drawY * ratio, sw * ratio, sh * ratio);

        onApply(out.toDataURL("image/webp", 0.85));
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
            <div className="bg-void-2 border border-line-strong rounded-2xl w-full max-w-sm shadow-2xl overflow-hidden">

                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-line">
                    <h3 className="text-sm font-semibold text-ink">Adjust Photo</h3>
                    <button
                        onClick={onCancel}
                        className="text-ink-2 hover:text-ink transition-colors"
                    >
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                            <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                    </button>
                </div>

                {/* Canvas preview */}
                <div className="flex flex-col items-center gap-4 p-6">
                    <p className="text-xs text-ink-2 text-center">
                        Drag to reposition · Use the slider to zoom
                    </p>

                    {/* Circular clipping mask */}
                    <div
                        className="relative rounded-full overflow-hidden border-2 border-line-strong cursor-grab active:cursor-grabbing select-none"
                        style={{ width: PREVIEW_SIZE, height: PREVIEW_SIZE }}
                        onMouseDown={onMouseDown}
                        onTouchStart={onTouchStart}
                    >
                        <canvas
                            ref={canvasRef}
                            width={PREVIEW_SIZE}
                            height={PREVIEW_SIZE}
                            className="block"
                        />
                        {!imgLoaded && (
                            <div className="absolute inset-0 flex items-center justify-center bg-void-3">
                                <div className="w-6 h-6 border-2 border-line-strong border-t-white rounded-full animate-spin" />
                            </div>
                        )}
                    </div>

                    {/* Zoom slider */}
                    <div className="w-full flex items-center gap-3">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-ink-3 flex-shrink-0">
                            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
                            <path d="M11 8v6M8 11h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                            <path d="M16.5 16.5L21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                        <input
                            type="range"
                            min="1"
                            max="3"
                            step="0.01"
                            value={crop.zoom}
                            onChange={handleZoom}
                            aria-label="Zoom"
                            /* `.range-ink` styles the THUMB, which `appearance-none`
                               does not reach. Without it the handle renders in the
                               OS accent colour — blue on Windows, and the last
                               unbranded colour in the app. See globals.css. */
                            className="range-ink h-1 flex-1 cursor-pointer appearance-none rounded-full"
                            style={{
                                background: `linear-gradient(to right, var(--color-ink) 0%, var(--color-ink) ${((crop.zoom - 1) / 2) * 100}%, var(--color-line-strong) ${((crop.zoom - 1) / 2) * 100}%, var(--color-line-strong) 100%)`
                            }}
                        />
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-ink-2 flex-shrink-0">
                            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
                            <path d="M11 8v6M8 11h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                            <path d="M16.5 16.5L21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                    </div>
                </div>

                {/* Footer actions */}
                <div className="flex gap-3 px-5 pb-5">
                    <button
                        onClick={onCancel}
                        className="flex-1 py-2.5 text-sm font-medium rounded-lg border border-line-strong text-ink-2 hover:bg-void-2 transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleApply}
                        className="flex-1 py-2.5 text-sm font-medium rounded-lg bg-ink text-void-0 hover:bg-ink/90 transition-colors"
                    >
                        Apply
                    </button>
                </div>
            </div>
        </div>
    );
}

// ─────────────────────────────────────────────────────────────
// Main ProfileClient
// ─────────────────────────────────────────────────────────────

export default function ProfileClient() {
    const userId = useUserId();
    const { profile: contextProfile, isLoading: isContextLoading, refreshProfile } = useUserProfile();
    const fileInputRef = useRef<HTMLInputElement>(null);

    const [profile, setProfile] = useState<UserProfile | null>(null);
    const [isEditing, setIsEditing] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [successMsg, setSuccessMsg] = useState<string | null>(null);

    // Crop modal state
    const [cropSrc, setCropSrc] = useState<string | null>(null);

    // Editable form state
    const [formData, setFormData] = useState({
        name: "",
        bio: "",
        birthDate: "",
        country: "",
        occupation: "",
        profilePhotoUrl: "",
        timezone: "",
    });

    // ── Sync profile from shared context ─────────────────────

    useEffect(() => {
        if (isContextLoading) {
            setIsLoading(true);
            return;
        }
        if (contextProfile) {
            setProfile(contextProfile);
            setFormData({
                name: contextProfile.name ?? "",
                bio: contextProfile.bio ?? "",
                birthDate: contextProfile.birthDate ?? "",
                country: contextProfile.country ?? "",
                occupation: contextProfile.occupation ?? "",
                profilePhotoUrl: contextProfile.profilePhotoUrl ?? "",
                timezone: contextProfile.timezone ?? "",
            });
        }
        setIsLoading(false);
    }, [contextProfile, isContextLoading]);

    // ── Handlers ───────────────────────────────────────────

    const handleEditToggle = () => {
        if (isEditing && profile) {
            // Cancel — reset form to last saved profile data
            setFormData({
                name: profile.name ?? "",
                bio: profile.bio ?? "",
                birthDate: profile.birthDate ?? "",
                country: profile.country ?? "",
                occupation: profile.occupation ?? "",
                profilePhotoUrl: profile.profilePhotoUrl ?? "",
                timezone: profile.timezone ?? "",
            });
        }
        setIsEditing((v) => !v);
        setError(null);
        setSuccessMsg(null);
    };

    const handleSave = async () => {
        if (!profile) return;
        setIsSaving(true);
        setError(null);
        setSuccessMsg(null);

        try {
            const payload: ProfileUpdatePayload = {
                name: formData.name || undefined,
                bio: formData.bio || null,
                birth_date: formData.birthDate || null,
                country: formData.country || null,
                occupation:
                    formData.occupation && formData.occupation !== "Select"
                        ? formData.occupation
                        : null,
                profile_photo_url: formData.profilePhotoUrl || null,
                timezone: formData.timezone || null,
            };

            const updated = await updateProfile(payload, userId);
            setProfile(updated);
            setFormData({
                name: updated.name ?? "",
                bio: updated.bio ?? "",
                birthDate: updated.birthDate ?? "",
                country: updated.country ?? "",
                occupation: updated.occupation ?? "",
                profilePhotoUrl: updated.profilePhotoUrl ?? "",
                timezone: updated.timezone ?? "",
            });
            setIsEditing(false);
            await refreshProfile();

            setSuccessMsg("Profile updated successfully!");
            setTimeout(() => setSuccessMsg(null), 3000);
        } catch (err) {
            setError("Failed to save profile. Please try again.");
            console.error(err);
        } finally {
            setIsSaving(false);
        }
    };

    // Open file picker → feed src into crop modal
    const handleUploadClick = () => {
        fileInputRef.current?.click();
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        // Reset so the same file can be picked again
        e.target.value = "";

        const reader = new FileReader();
        reader.onload = () => {
            setCropSrc(reader.result as string);
        };
        reader.readAsDataURL(file);
    };

    const handleCropApply = (dataUrl: string) => {
        setFormData((prev) => ({ ...prev, profilePhotoUrl: dataUrl }));
        setCropSrc(null);
    };

    const handleCropCancel = () => {
        setCropSrc(null);
    };

    const handleChange = (field: keyof typeof formData, value: string) => {
        setFormData((prev) => ({ ...prev, [field]: value }));
    };

    // ── Computed ───────────────────────────────────────────

    // Empty string rather than an imported asset: the fallback is now drawn
    // inline where it renders, so there is nothing to import.
    const displayPhoto: string = formData.profilePhotoUrl || "";

    const displayBirthDate = (() => {
        if (!profile?.birthDate) return "—";
        const parts = profile.birthDate.split("-");
        if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
        return profile.birthDate;
    })();

    // ── Render ─────────────────────────────────────────────

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="flex flex-col items-center gap-3">
                    <div className="w-8 h-8 border-2 border-line-strong border-t-white rounded-full animate-spin" />
                    <span className="text-sm text-ink-2">Loading profile…</span>
                </div>
            </div>
        );
    }

    if (!profile) {
        return (
            <div className="flex items-center justify-center h-full">
                <p className="text-ink-2">Could not load profile.</p>
            </div>
        );
    }

    return (
        <>
            {/* ── Crop modal (portal-style, rendered above everything) ── */}
            {cropSrc && (
                <AvatarCropModal
                    src={cropSrc}
                    onApply={handleCropApply}
                    onCancel={handleCropCancel}
                />
            )}

            <div className="max-w-4xl mx-auto">
                {/* ── Status messages ──────────────────────────────── */}
                {error && (
                    <div className="mb-4 flex gap-3 rounded-xl border border-line-strong bg-void-2 px-4 py-3.5 text-sm text-ink-2">
                        {error}
                    </div>
                )}
                {successMsg && (
                    <div className="mb-4 flex gap-3 rounded-xl border border-line-strong bg-void-2 px-4 py-3.5 text-sm text-ink">
                        {successMsg}
                    </div>
                )}

                {/* ── Page heading ─────────────────────────────────── */}
                <h1 className="text-3xl font-bold text-ink mb-5">Profile</h1>
                <div className="border-t border-dashed border-border mb-8" />

                {/* ── Two-card layout ──────────────────────────────── */}
                <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-6">

                    {/* ── Left card: Avatar ──────────────────────────── */}
                    <div className="border border-border rounded-2xl p-6 flex flex-col items-center gap-5">
                        {/* User name */}
                        <h2 className="text-lg font-semibold text-ink text-center">
                            {profile.name}
                        </h2>

                        {/* Avatar.

                            The fallback is drawn inline rather than loaded from
                            `ic-profile-user.svg`, which has `fill="#5A2CFF"`
                            baked in — a purple that appears nowhere else in the
                            product and that no token could reach through an
                            <img>. */}
                        <div className="relative h-44 w-44 overflow-hidden rounded-full ring-1 ring-line-strong">
                            {displayPhoto ? (
                                <Image
                                    src={displayPhoto}
                                    alt="Profile photo"
                                    fill
                                    unoptimized
                                    className="object-cover"
                                />
                            ) : (
                                <svg
                                    viewBox="0 0 32 32"
                                    fill="none"
                                    aria-hidden
                                    className="h-full w-full bg-void-3 text-ink-3"
                                >
                                    <circle cx="16" cy="12.5" r="4.75" stroke="currentColor" strokeWidth="1.3" />
                                    <path d="M7 26c0-4.6 4-7.5 9-7.5s9 2.9 9 7.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                                </svg>
                            )}
                        </div>

                        {/* Upload button — active only when edit mode is on */}
                        <button
                            onClick={isEditing ? handleUploadClick : undefined}
                            disabled={!isEditing}
                            title={isEditing ? "Upload a new profile photo" : "Click Edit first to change your photo"}
                            className={`flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg border transition-all ${
                                isEditing
                                    ? "border-line-strong text-ink-2 hover:bg-void-2 hover:border-line-strong hover:text-ink cursor-pointer"
                                    : "border-line text-ink-3/60 cursor-not-allowed opacity-50"
                            }`}
                        >
                            {/* Upload icon */}
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" className="flex-shrink-0">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                <polyline points="17 8 12 3 7 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                <line x1="12" y1="3" x2="12" y2="15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                            </svg>
                            Upload Photo
                        </button>

                        {/* Hidden file input */}
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/*"
                            onChange={handleFileChange}
                            className="hidden"
                        />

                        {/* Tip: unsaved photo indicator */}
                        {formData.profilePhotoUrl !== (profile.profilePhotoUrl ?? "") && (
                            <p className="text-center text-[11px] text-ink-2">
                                New photo selected — click Save Changes to apply
                            </p>
                        )}
                    </div>

                    {/* ── Right card: Bio & other details ───────────── */}
                    <div className="border border-border rounded-2xl p-6">
                        {/* Header with single edit toggle */}
                        <div className="flex items-center justify-between mb-6">
                            <h2 className="text-lg font-semibold text-ink">
                                Bio & other details
                            </h2>
                            <button
                                onClick={handleEditToggle}
                                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                                    isEditing
                                        ? "bg-void-3 text-ink border border-line-strong"
                                        : "border border-line-strong text-ink-2 hover:bg-void-2 hover:text-ink"
                                }`}
                                title={isEditing ? "Cancel editing" : "Edit profile details"}
                            >
                                {isEditing ? (
                                    <>
                                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                                            <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                                        </svg>
                                        Cancel
                                    </>
                                ) : (
                                    <>
                                        <Image src="/icons/ic-edit.svg" alt="" width={12} height={12} className="opacity-60" />
                                        Edit
                                    </>
                                )}
                            </button>
                        </div>

                        {/* Fields */}
                        <div className="space-y-5">
                            {/* Row 1: Name + Birth Date */}
                            <div className="grid grid-cols-2 gap-6">
                                <FieldRow
                                    label="Name"
                                    value={formData.name}
                                    isEditing={isEditing}
                                    onChange={(v) => handleChange("name", v)}
                                    placeholder="Your name"
                                />
                                <FieldRow
                                    label="Birth Date"
                                    value={isEditing ? formData.birthDate : displayBirthDate}
                                    isEditing={isEditing}
                                    onChange={(v) => handleChange("birthDate", v)}
                                    type="date"
                                    placeholder="YYYY-MM-DD"
                                />
                            </div>

                            {/* Row 2: Age + Country */}
                            <div className="grid grid-cols-2 gap-6">
                                <FieldRow
                                    label="Age"
                                    value={profile.age != null ? `${profile.age}` : "—"}
                                    isEditing={false}
                                />
                                <FieldRow
                                    label="Country"
                                    value={formData.country}
                                    isEditing={isEditing}
                                    onChange={(v) => handleChange("country", v)}
                                    placeholder="e.g. Malaysia"
                                />
                            </div>

                            {/* Row 3: Occupation */}
                            <div>
                                <label htmlFor="profile-occupation" className="block text-xs text-muted-foreground mb-1.5">
                                    What best describes your work?
                                </label>
                                {isEditing ? (
                                    <select
                                        id="profile-occupation"
                                        value={formData.occupation || "Select"}
                                        onChange={(e) => handleChange("occupation", e.target.value)}
                                        className="w-full bg-background border border-border rounded-lg px-3 py-2.5 text-sm text-foreground focus:outline-none focus:border-ink-3 transition-colors appearance-none cursor-pointer"
                                        style={{
                                            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 5l3 3 3-3' stroke='%23666' fill='none' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E")`,
                                            backgroundRepeat: "no-repeat",
                                            backgroundPosition: "right 12px center",
                                        }}
                                    >
                                        {OCCUPATION_OPTIONS.map((opt) => (
                                            <option key={opt} value={opt}>{opt}</option>
                                        ))}
                                    </select>
                                ) : (
                                    <div className="flex items-center justify-between border-b border-border pb-2">
                                        <span className="text-sm text-ink-2">
                                            {formData.occupation || "—"}
                                        </span>
                                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="text-muted-foreground">
                                            <path d="M3 5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                                        </svg>
                                    </div>
                                )}
                            </div>

                            {/* Row 4: Timezone */}
                            <div>
                                <label htmlFor="profile-timezone" className="block text-xs text-muted-foreground mb-1.5">
                                    Timezone
                                </label>
                                {isEditing ? (
                                    <select
                                        id="profile-timezone"
                                        value={formData.timezone || ""}
                                        onChange={(e) => handleChange("timezone", e.target.value)}
                                        className="w-full bg-background border border-border rounded-lg px-3 py-2.5 text-sm text-foreground focus:outline-none focus:border-ink-3 transition-colors appearance-none cursor-pointer"
                                        style={{
                                            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 5l3 3 3-3' stroke='%23666' fill='none' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E")`,
                                            backgroundRepeat: "no-repeat",
                                            backgroundPosition: "right 12px center",
                                        }}
                                    >
                                        <option value="">Select timezone</option>
                                        {Intl.supportedValuesOf("timeZone").map((tz) => (
                                            <option key={tz} value={tz}>{tz.replace(/_/g, " ")}</option>
                                        ))}
                                    </select>
                                ) : (
                                    <p className="text-sm text-foreground font-medium border-b border-border pb-2">
                                        {formData.timezone
                                            ? formData.timezone.replace(/_/g, " ")
                                            : <span className="text-muted-foreground">—</span>}
                                    </p>
                                )}
                            </div>
                        </div>

                        {/* ── Save button ──────────────────────────── */}
                        <div className="flex justify-end mt-8">
                            <button
                                onClick={handleSave}
                                disabled={isSaving || !isEditing}
                                className={`px-6 py-2.5 text-sm font-medium rounded-lg transition-colors ${
                                    isEditing
                                        ? "bg-ink text-void-0 hover:bg-ink/90 cursor-pointer"
                                        : "bg-void-3 text-ink-3 cursor-not-allowed"
                                }`}
                            >
                                {isSaving ? (
                                    <span className="flex items-center gap-2">
                                        <span className="w-4 h-4 border-2 border-void-0/25 border-t-void-0 rounded-full animate-spin" />
                                        Saving…
                                    </span>
                                ) : (
                                    "Save Changes"
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
                {/* Change password. Lives here because the forgot-password page used to
                    tell users this control existed on their profile when it did not — see
                    ChangePassword.tsx. Hidden for OAuth-only accounts, decided server-side
                    from `has_password`. */}
                <div className="mt-6">
                    <ChangePassword hasPassword={profile?.hasPassword ?? false} />
                </div>
        </>
    );
}

// ── Reusable field row ───────────────────────────────────────

function FieldRow({
    label,
    value,
    isEditing,
    onChange,
    type = "text",
    placeholder,
}: {
    label: string;
    value: string;
    isEditing: boolean;
    onChange?: (value: string) => void;
    type?: string;
    placeholder?: string;
}) {
    // The label was a SIBLING of the input with no htmlFor and no id, so a screen
    // reader announced every profile field — name, bio, birth date, country — as
    // an unlabelled edit box. `useId` rather than a slug of the label text: two
    // fields could share a label, and duplicate ids silently associate the second
    // label with the first input.
    const inputId = useId();
    return (
        <div>
            <label htmlFor={inputId} className="block text-xs text-muted-foreground mb-1.5">
                {label}
            </label>
            {isEditing && onChange ? (
                <input
                    id={inputId}
                    type={type}
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={placeholder}
                    className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-ink-3 transition-colors"
                />
            ) : (
                <p className="text-sm text-foreground font-medium border-b border-border pb-2">
                    {value ? value : <span className="text-muted-foreground">—</span>}
                </p>
            )}
        </div>
    );
}
