"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import StorageRing from "@/app/components/profile/StorageRing";

type ProfileData = {
  email: string;
  givenName: string;
  familyName: string;
  preferredUsername: string;
  gender: string;
  quotaBytes: number;
  usedBytes: number;
  videosCount: number;
  createdAt: string | null;
};

export default function ProfileClient() {
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Form state
  const [givenName, setGivenName] = useState("");
  const [familyName, setFamilyName] = useState("");
  const [preferredUsername, setPreferredUsername] = useState("");
  const [gender, setGender] = useState("");

  useEffect(() => {
    fetchProfile();
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
      setGivenName(data.givenName || "");
      setFamilyName(data.familyName || "");
      setPreferredUsername(data.preferredUsername || "");
      setGender(data.gender || "");
    } catch (err: any) {
      setError(err?.message || "Failed to load.");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      const resp = await fetch("/api/user/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          givenName,
          familyName,
          preferredUsername,
          gender,
        }),
      });

      if (!resp.ok) {
        const data = (await resp.json()) as { error?: string };
        throw new Error(data.error || "Save failed.");
      }

      setSuccess("Profile updated.");
      // Refresh profile to get updated data
      await fetchProfile();
    } catch (err: any) {
      setError(err?.message || "Save failed.");
    } finally {
      setSaving(false);
    }
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
            quotaBytes={profile?.quotaBytes || 256 * 1024 * 1024 * 1024}
            size={140}
            strokeWidth={12}
          />
          <div className="profile-stats">
            <div className="profile-stat">
              <span className="profile-stat__value">{profile?.videosCount || 0}</span>
              <span className="profile-stat__label">Videos</span>
            </div>
          </div>
        </div>

        {/* Edit Card */}
        <div className="profile-card profile-card--form">
          <h2>Edit profile</h2>
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

            <button
              type="submit"
              className="auth-submit"
              disabled={saving}
            >
              {saving ? "Saving..." : "Save changes"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
