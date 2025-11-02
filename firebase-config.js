// firebase-config.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.24.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/9.24.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/9.24.0/firebase-firestore.js";

// Your Firebase project config
const firebaseConfig = {
  apiKey: "AIzaSyBDYLrPmmPvu0PfEa6qIDv4kgyHQM8mQ54",
  authDomain: "cobaintech-aff85.firebaseapp.com",
  projectId: "cobaintech-aff85",
  storageBucket: "cobaintech-aff85.appspot.com",
  messagingSenderId: "70064253311",
  appId: "1:70064253311:web:fd7b0680f82143f308124a",
  measurementId: "G-1BEEG4EVBR"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Make Firebase accessible globally
window.auth = auth;
window.db = db;
