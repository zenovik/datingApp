import { Component } from '@angular/core';
import { NgFor } from '@angular/common';
import { RouterLink } from '@angular/router';
import { RevealOnScrollDirective } from '../../core/motion/reveal-on-scroll.directive';

interface Highlight {
  icon: string;
  title: string;
  description: string;
}

const HIGHLIGHTS: Highlight[] = [
  {
    icon: 'bi-people-fill',
    title: 'Smart Matching',
    description: 'We surface people who actually fit what you are looking for, not just whoever is nearby.',
  },
  {
    icon: 'bi-camera-video-fill',
    title: 'Video Calls',
    description: 'See each other face-to-face before you ever meet up, right inside the app.',
  },
  {
    icon: 'bi-chat-heart-fill',
    title: 'Real-time Chat',
    description: 'Message instantly with read receipts, reactions, and photo sharing.',
  },
];

@Component({
  selector: 'app-landing',
  templateUrl: './landing.component.html',
  styleUrls: ['./landing.component.css'],
  imports: [RouterLink, NgFor, RevealOnScrollDirective],
})
export class LandingComponent {
  readonly highlights = HIGHLIGHTS;
}
