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
        throw new Error("获取资料失败");
      }
      const data = (await resp.json()) as ProfileData;
      setProfile(data);
      setGivenName(data.givenName || "");
      setFamilyName(data.familyName || "");
      setPreferredUsername(data.preferredUsername || "");
      setGender(data.gender || "");
    } catch (err: any) {
      setError(err?.message || "加载失败");
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
        throw new Error(data.error || "保存失败");
      }

      setSuccess("资料已更新");
      // Refresh profile to get updated data
      await fetchProfile();
    } catch (err: any) {
      setError(err?.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="profile-page">
        <div className="profile-card">
          <p className="muted">加载中...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="profile-page">
      <div className="profile-header">
        <Link href="/dashboard" className="back-link">
          ← 返回视频
        </Link>
        <h1>个人资料</h1>
      </div>

      {error && <div className="auth-errors">{error}</div>}
      {success && <div className="auth-feedback">{success}</div>}

      <div className="profile-grid">
        {/* Stats Card */}
        <div className="profile-card profile-card--stats">
          <h2>存储统计</h2>
          <StorageRing
            usedBytes={profile?.usedBytes || 0}
            quotaBytes={profile?.quotaBytes || 256 * 1024 * 1024 * 1024}
            size={140}
            strokeWidth={12}
          />
          <div className="profile-stats">
            <div className="profile-stat">
              <span className="profile-stat__value">{profile?.videosCount || 0}</span>
              <span className="profile-stat__label">视频数量</span>
            </div>
          </div>
        </div>

        {/* Edit Card */}
        <div className="profile-card profile-card--form">
          <h2>编辑资料</h2>
          <form onSubmit={handleSubmit}>
            <div className="field-group">
              <label htmlFor="email">邮箱</label>
              <input
                type="email"
                id="email"
                value={profile?.email || ""}
                disabled
                className="input--disabled"
              />
              <span className="field-hint">邮箱不可修改</span>
            </div>

            <div className="field-grid">
              <div className="field-group">
                <label htmlFor="givenName">名字</label>
                <input
                  type="text"
                  id="givenName"
                  value={givenName}
                  onChange={(e) => setGivenName(e.target.value)}
                  placeholder="名"
                />
              </div>
              <div className="field-group">
                <label htmlFor="familyName">姓氏</label>
                <input
                  type="text"
                  id="familyName"
                  value={familyName}
                  onChange={(e) => setFamilyName(e.target.value)}
                  placeholder="姓"
                />
              </div>
            </div>

            <div className="field-group">
              <label htmlFor="preferredUsername">用户名</label>
              <input
                type="text"
                id="preferredUsername"
                value={preferredUsername}
                onChange={(e) => setPreferredUsername(e.target.value)}
                placeholder="你的昵称"
              />
            </div>

            <div className="field-group">
              <label htmlFor="gender">性别</label>
              <select
                id="gender"
                value={gender}
                onChange={(e) => setGender(e.target.value)}
              >
                <option value="">选择性别</option>
                <option value="Male">男</option>
                <option value="Female">女</option>
                <option value="Other">其他</option>
              </select>
            </div>

            <button
              type="submit"
              className="auth-submit"
              disabled={saving}
            >
              {saving ? "保存中..." : "保存修改"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
