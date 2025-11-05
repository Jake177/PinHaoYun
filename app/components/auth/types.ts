export type GenderOption = "Male" | "Female" | "Other";

export type RegistrationFormState = {
  email: string;
  password: string;
  confirmPassword: string;
  preferredUsername: string;
  givenName: string;
  familyName: string;
  gender: GenderOption;
};
