import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import {
  getAuth,
  signInAnonymously
} from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyAR_c3VadEJE0a2CopEtvUcR_-w5T_tF4w",
  authDomain: "hsct-breathing-study.firebaseapp.com",
  databaseURL:
    "https://hsct-breathing-study-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "hsct-breathing-study",
  storageBucket:
    "hsct-breathing-study.firebasestorage.app",
  messagingSenderId: "727521885146",
  appId: "1:727521885146:web:6507781520a054d03b1ee3",
  measurementId: "G-3PG010ED7L",
};

const app = initializeApp(firebaseConfig);

/* Firestore */
export const db = getFirestore(app);

/* Firebase Authentication */
export const auth = getAuth(app);

/*
  Firebase 匿名登入
  所有使用者開啟 App 後都會取得一個匿名 UID。

  例如：
  P001 → uid A
  P002 → uid B
  P003 → uid C
*/
export const authReady = signInAnonymously(auth)
  .then((result) => {
    console.log(
      "Firebase 匿名登入成功",
      result.user.uid
    );

    return result.user;
  })
  .catch((error) => {
    console.error(
      "Firebase 匿名登入失敗:",
      error
    );

    throw error;
  });