// Import Firebase SDKs
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.24.0/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/9.24.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyBDYLrPmmPvu0PfEa6qIDv4kgyHQM8mQ54",
  authDomain: "cobaintech-aff85.firebaseapp.com",
  projectId: "cobaintech-aff85",
  storageBucket: "cobaintech-aff85.appspot.com",
  messagingSenderId: "70064253311",
  appId: "1:70064253311:web:fd7b0680f82143f308124a",
  measurementId: "G-1BEEG4EVBR"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Example signup function
document.getElementById("signupForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const email = document.getElementById("signupEmail").value;
  const password = document.getElementById("signupPassword").value;
  createUserWithEmailAndPassword(auth, email, password)
    .then((userCredential) => {
      alert("Sign up successful!");
      window.location.href = "login.html";
    })
    .catch((error) => {
      alert(error.message);
    });
});
