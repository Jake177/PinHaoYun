"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import type { Route } from "next";
import StorageRing from "@/app/components/profile/StorageRing";
import SignaturePadModal from "@/app/components/profile/SignaturePadModal";
import { DEFAULT_PLAN_CODE, getPlanQuotaBytes } from "@/app/lib/plans";

type SignatureAction = "KEEP" | "REPLACE" | "DELETE";

type ProfileData = {
  email: string;
  givenName: string;
  familyName: string;
  preferredUsername: string;
  gender: string;
  bio: string;
  signatureUrl: string | null;
  hasSignature: boolean;
  signatureUpdatedAt: string | null;
  planCode: string;
  planDisplayName: string;
  planPriceLabel: string;
  planStatus: string;
  pendingPlanCode: string | null;
  pendingPlanDisplayName: string | null;
  currentPeriodEnd: string | null;
  gracePeriodEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  isLegacy: boolean;
  quotaBytes: number;
  usedBytes: number;
  photoBytes: number;
  videoBytes: number;
  videosCount: number;
  photoCount: number;
  createdAt: string | null;
};

const BIO_MAX_CHARS = 200;

const formatDate = (value: string | null): string | null => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
};

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[i]}`;
};

export default function ProfileClient() {
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Form state
  const [givenName, setGivenName] = useState("");
  const [familyName, setFamilyName] = useState("");
  const [preferredUsername, setPreferredUsername] = useState("");
  const [gender, setGender] = useState("");
  const [bio, setBio] = useState("");

  // Signature state for edit mode
  const [signaturePreviewUrl, setSignaturePreviewUrl] = useState<string | null>(null);
  const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);
  const [signatureAction, setSignatureAction] = useState<SignatureAction>("KEEP");
  const [showSignaturePad, setShowSignaturePad] = useState(false);
  const [showSignatureDeleteConfirm, setShowSignatureDeleteConfirm] = useState(false);

  const resetFormFromProfile = (data: ProfileData | null) => {
    setGivenName(data?.givenName || "");
    setFamilyName(data?.familyName || "");
    setPreferredUsername(data?.preferredUsername || "");
    setGender(data?.gender || "");
    setBio(data?.bio || "");
    setSignaturePreviewUrl(data?.signatureUrl || null);
    setSignatureDataUrl(null);
    setSignatureAction("KEEP");
    setShowSignaturePad(false);
    setShowSignatureDeleteConfirm(false);
  };

  useEffect(() => {
    fetchProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchProfile = async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch("/api/user/profile");
      if (!resp.ok) {
        throw new Error("Failed to fetch profile.");
      }
      const data = (await resp.json()) as ProfileData;
      setProfile(data);
      resetFormFromProfile(data);
    } catch (err: any) {
      setError(err?.message || "Failed to load.");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(null);

    if (bio.length > BIO_MAX_CHARS) {
      setError(`Bio must be ${BIO_MAX_CHARS} characters or fewer.`);
      setSaving(false);
      return;
    }

    try {
      const payload: Record<string, unknown> = {
        givenName,
        familyName,
        preferredUsername,
        gender,
        bio,
        signatureAction,
      };

      if (signatureAction === "REPLACE" && signatureDataUrl) {
        payload.signatureDataUrl = signatureDataUrl;
      }

      const resp = await fetch("/api/user/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        const data = (await resp.json()) as { error?: string };
        throw new Error(data.error || "Save failed.");
      }

      setSuccess("Profile updated.");
      setIsEditing(false);
      await fetchProfile();
    } catch (err: any) {
      setError(err?.message || "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    resetFormFromProfile(profile);
    setError(null);
  };

  const handleOpenEdit = () => {
    resetFormFromProfile(profile);
    setIsEditing(true);
    setSuccess(null);
    setError(null);
  };

  const handleAddSignature = (dataUrl: string) => {
    setSignaturePreviewUrl(dataUrl);
    setSignatureDataUrl(dataUrl);
    setSignatureAction("REPLACE");
    setShowSignaturePad(false);
  };

  const handleConfirmSignatureDelete = () => {
    setSignaturePreviewUrl(null);
    setSignatureDataUrl(null);
    setSignatureAction("DELETE");
    setShowSignatureDeleteConfirm(false);
  };

  if (loading) {
    return (
      <div className="profile-page">
        <div className="profile-card">
          <p className="muted">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="profile-page">
        <div className="profile-header">
          <Link href="/dashboard" className="back-link">
            ← Back to videos
          </Link>
          <h1>Profile</h1>
        </div>

        {error && <div className="auth-errors">{error}</div>}
        {success && <div className="auth-feedback">{success}</div>}

        <div className="profile-grid">
          {/* Stats Card */}
          <div className="profile-card profile-card--stats">
            <h2>Storage</h2>
            <StorageRing
              usedBytes={profile?.usedBytes || 0}
              quotaBytes={profile?.quotaBytes || getPlanQuotaBytes(DEFAULT_PLAN_CODE)}
              size={140}
              strokeWidth={12}
            />
            <div className="profile-membership">
              <div className="profile-membership__eyebrow">Membership</div>
              <div className="profile-membership__title">
                {profile?.planDisplayName || "Free"}
              </div>
              <div className="profile-membership__meta">
                {profile?.isLegacy
                  ? "Legacy 5TB account"
                  : profile?.planStatus === "grace_period"
                    ? `Payment grace until ${formatDate(profile.gracePeriodEndsAt) || "soon"}`
                    : profile?.pendingPlanDisplayName
                      ? `Switches to ${profile.pendingPlanDisplayName} next cycle`
                      : profile?.currentPeriodEnd
                        ? `Renews ${formatDate(profile.currentPeriodEnd) || "soon"}`
                        : profile?.planPriceLabel || "Manage your storage plan"}
              </div>
              <Link
                href={"/dashboard/plans" as Route}
                className="profile-membership__link"
              >
                Manage plan
              </Link>
            </div>
            <div className="storage-breakdown">
              <div className="storage-breakdown__row">
                <span className="storage-breakdown__icon storage-breakdown__icon--photo material-symbols-outlined">photo</span>
                <span className="storage-breakdown__label">Photos</span>
                <span className="storage-breakdown__count">{profile?.photoCount || 0}</span>
                <span className="storage-breakdown__size">{formatBytes(profile?.photoBytes || 0)}</span>
              </div>
              <div className="storage-breakdown__row">
                <span className="storage-breakdown__icon storage-breakdown__icon--video material-symbols-outlined">video_file</span>
                <span className="storage-breakdown__label">Videos</span>
                <span className="storage-breakdown__count">{profile?.videosCount || 0}</span>
                <span className="storage-breakdown__size">{formatBytes(profile?.videoBytes || 0)}</span>
              </div>
            </div>
          </div>

          {/* Profile Info Card */}
          <div className="profile-card profile-card--form">
            <div className="profile-card__header">
              <h2>Personal Information</h2>
              {!isEditing && (
                <button
                  type="button"
                  className="pill pill--secondary"
                  onClick={handleOpenEdit}
                >
                  Edit
                </button>
              )}
            </div>

            {isEditing ? (
              <form onSubmit={handleSubmit}>
                <div className="field-group">
                  <label htmlFor="email">Email</label>
                  <input
                    type="email"
                    id="email"
                    value={profile?.email || ""}
                    disabled
                    className="input--disabled"
                  />
                  <span className="field-hint">Email cannot be changed</span>
                </div>

                <div className="field-grid">
                  <div className="field-group">
                    <label htmlFor="givenName">First name</label>
                    <input
                      type="text"
                      id="givenName"
                      value={givenName}
                      onChange={(e) => setGivenName(e.target.value)}
                      placeholder="First name"
                    />
                  </div>
                  <div className="field-group">
                    <label htmlFor="familyName">Surname</label>
                    <input
                      type="text"
                      id="familyName"
                      value={familyName}
                      onChange={(e) => setFamilyName(e.target.value)}
                      placeholder="Surname"
                    />
                  </div>
                </div>

                <div className="field-group">
                  <label htmlFor="preferredUsername">Username</label>
                  <input
                    type="text"
                    id="preferredUsername"
                    value={preferredUsername}
                    onChange={(e) => setPreferredUsername(e.target.value)}
                    placeholder="Your display name"
                  />
                </div>

                <div className="field-group">
                  <label htmlFor="gender">Gender</label>
                  <select
                    id="gender"
                    value={gender}
                    onChange={(e) => setGender(e.target.value)}
                  >
                    <option value="">Select gender</option>
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                    <option value="Other">Other</option>
                  </select>
                </div>

                <div className="field-group">
                  <div className="profile-bio__header">
                    <label htmlFor="bio">Bio</label>
                    <span className="profile-bio__count">{bio.length}/{BIO_MAX_CHARS}</span>
                  </div>
                  <textarea
                    id="bio"
                    value={bio}
                    onChange={(e) => setBio(e.target.value)}
                    placeholder="Write a short introduction about yourself"
                    maxLength={BIO_MAX_CHARS}
                    rows={4}
                    className="profile-bio__textarea"
                  />
                  <span className="field-hint">Optional, up to 200 characters.</span>
                </div>

                <div className="field-group">
                  <div className="profile-signature__header">
                    <label>Signature</label>
                    {signaturePreviewUrl ? (
                      <button
                        type="button"
                        className="icon-button icon-button--remove"
                        aria-label="Delete signature"
                        onClick={() => setShowSignatureDeleteConfirm(true)}
                      >
                        <span className="material-symbols-outlined" aria-hidden="true">
                          remove
                        </span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="icon-button icon-button--add"
                        aria-label="Add signature"
                        onClick={() => setShowSignaturePad(true)}
                      >
                        <span className="material-symbols-outlined" aria-hidden="true">
                          add
                        </span>
                      </button>
                    )}
                  </div>
                  <div className="profile-signature__preview">
                    {signaturePreviewUrl ? (
                      <img src={signaturePreviewUrl} alt="Signature preview" />
                    ) : (
                      <div className="profile-signature__empty">No signature added</div>
                    )}
                  </div>
                  <span className="field-hint">Optional, you can sign with touch, stylus, mouse, or trackpad.</span>
                </div>

                <div className="profile-form__actions">
                  <button
                    type="button"
                    className="pill pill--secondary"
                    onClick={handleCancelEdit}
                    disabled={saving}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="pill pill--primary"
                    disabled={saving}
                  >
                    {saving ? "Saving..." : "Save"}
                  </button>
                </div>
              </form>
            ) : (
              <div className="profile-view">
                <div className="profile-view__row">
                  <span className="profile-view__label">Email</span>
                  <span className="profile-view__value">{profile?.email || "—"}</span>
                </div>
                <div className="profile-view__row">
                  <span className="profile-view__label">Name</span>
                  <span className="profile-view__value">
                    {[profile?.givenName, profile?.familyName].filter(Boolean).join(" ") || "—"}
                  </span>
                </div>
                <div className="profile-view__row">
                  <span className="profile-view__label">Username</span>
                  <span className="profile-view__value">{profile?.preferredUsername || "—"}</span>
                </div>
                <div className="profile-view__row">
                  <span className="profile-view__label">Membership</span>
                  <span className="profile-view__value">
                    {profile?.planDisplayName || "—"}
                  </span>
                </div>
                <div className="profile-view__row">
                  <span className="profile-view__label">Gender</span>
                  <span className="profile-view__value">{profile?.gender || "—"}</span>
                </div>
                <div className="profile-view__row profile-view__row--stacked">
                  <span className="profile-view__label">Bio</span>
                  <span className="profile-view__value profile-view__value--multiline">
                    {profile?.bio?.trim() || "—"}
                  </span>
                </div>
                <div className="profile-view__row profile-view__row--stacked">
                  <span className="profile-view__label">Signature</span>
                  <span className="profile-view__value">
                    {profile?.signatureUrl ? (
                      <img
                        src={profile.signatureUrl}
                        alt="User signature"
                        className="profile-signature__image"
                      />
                    ) : (
                      "—"
                    )}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {showSignaturePad ? (
        <SignaturePadModal
          onClose={() => setShowSignaturePad(false)}
          onAdd={handleAddSignature}
        />
      ) : null}

      {showSignatureDeleteConfirm ? (
        <div
          className="confirm-modal"
          role="alertdialog"
          aria-modal="true"
          onClick={() => setShowSignatureDeleteConfirm(false)}
        >
          <div
            className="confirm-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="confirm-dialog__title">Delete signature?</h3>
            <p className="confirm-dialog__text">This action can be undone by adding a new signature.</p>
            <div className="confirm-dialog__actions">
              <button
                type="button"
                className="pill"
                onClick={() => setShowSignatureDeleteConfirm(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="pill pill--error"
                onClick={handleConfirmSignatureDelete}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
