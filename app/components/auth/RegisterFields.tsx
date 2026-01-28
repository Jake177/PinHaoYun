"use client";

import type { ChangeEvent } from "react";
import type { GenderOption, RegistrationFormState } from "./types";

type Option = { value: GenderOption; label: string };

type RegisterFieldsProps = {
  formState: Pick<
    RegistrationFormState,
    "givenName" | "familyName" | "preferredUsername" | "gender"
  >;
  onChange: (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
  genderOptions: ReadonlyArray<Option>;
};

export default function RegisterFields({
  formState,
  onChange,
  genderOptions,
}: RegisterFieldsProps) {
  return (
    <>
      <div className="field-grid">
        <div className="field-group">
          <label htmlFor="givenName">First name</label>
          <input
            id="givenName"
            name="givenName"
            type="text"
            placeholder="e.g. Hao Yun"
            autoComplete="given-name"
            value={formState.givenName}
            onChange={onChange}
            required
          />
        </div>
        <div className="field-group">
          <label htmlFor="familyName">Surname</label>
          <input
            id="familyName"
            name="familyName"
            type="text"
            placeholder="e.g. Pin"
            autoComplete="family-name"
            value={formState.familyName}
            onChange={onChange}
            required
          />
        </div>
      </div>

      <div className="field-group">
        <label htmlFor="preferredUsername">Username</label>
        <input
          id="preferredUsername"
          name="preferredUsername"
          type="text"
          placeholder="Your public display name"
          autoComplete="username"
          value={formState.preferredUsername}
          onChange={onChange}
          required
        />
      </div>

      <div className="field-group">
        <label htmlFor="gender">Gender</label>
        <select
          id="gender"
          name="gender"
          value={formState.gender}
          onChange={onChange}
          required
        >
          {genderOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
